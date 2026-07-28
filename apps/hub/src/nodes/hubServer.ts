import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BunHttpServer } from "@effect/platform-bun";
import {
  Args,
  type Dep,
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import {
  FrondHubRpcs,
  HUB_ATTACH_PATH,
  HUB_PROTOCOL_VERSION,
  type HubCommand,
  HubRejection,
  type ValuePolicy,
} from "@frondruntime/devtools";
import { Clock, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { mcpLayer } from "../mcp.ts";
import { HUB_VERSION } from "../version.ts";
import { AttachmentsNode } from "./attachments.ts";
import { type HubConfigArgs, HubConfigNode } from "./hubConfig.ts";

/**
 * What the hub asks attached apps to send.
 *
 * `"full"` because an agent that can only see the shape of a value cannot
 * answer the question it was asked: "the result had these three keys" is not a
 * debugging session. This is a local devtools daemon on loopback, pointed at
 * development data, and it is worth being explicit that the tradeoff is
 * deliberate and scoped to that.
 *
 * Asking is all this does. Senders default their ceiling to `"shape"` and clamp
 * in `resolvePolicy`, so the common answer to this request is a refusal — which
 * is the intended arrangement, not a gap. The decision to put real values on a
 * socket belongs to the app that owns them, not to the tool reading them.
 */
const HUB_REQUESTED_VALUES: ValuePolicy = "full";

const HEARTBEAT_INTERVAL = "30 seconds";

const SHUTDOWN_TIMEOUT = "3 seconds";

/**
 * Why an attachment was refused, in one line somebody can act on.
 *
 * The old text was `"rejected"`, which named neither version nor a next step —
 * and a version mismatch is precisely the failure where the developer has
 * nothing else to go on, because the symptom is devtools that quietly never
 * connect. Both numbers appear because neither side can work the answer out
 * alone: the app knows only what it was compiled against, and the hub only sees
 * a number it does not recognize.
 *
 * Naming which side is behind is the part that decides what to upgrade, and it
 * is cheap here and a guess anywhere else. One line, because this ends up in a
 * terminal next to whatever else the app is printing.
 */
function protocolMismatch(appVersion: number): string {
  const behind =
    appVersion < HUB_PROTOCOL_VERSION
      ? "the app is behind, upgrade @frondruntime/devtools in the app"
      : "the hub is behind, upgrade @frondruntime/hub";

  return `protocol version mismatch: app speaks ${appVersion}, hub speaks ${HUB_PROTOCOL_VERSION}; ${behind}`;
}

export type HubServerResult = {
  readonly attachUrl: string;
  readonly host: string;
  readonly port: number;
  readonly lockfilePath: string;
  readonly startedAt: number;
  /**
   * Lifetime of the listening socket and every in-flight attachment.
   *
   * It lives on the result rather than in a module-level map because `release`
   * reads the result and nothing else: the node's own teardown is the only
   * thing allowed to close it.
   */
  readonly serverScope: Scope.Scope;
};

type HubServerDeps = {
  readonly config: Dep<typeof HubConfigNode>;
  readonly attachments: Dep<typeof AttachmentsNode>;
};

type HubServerSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: HubConfigArgs;
  readonly key: Key.Structure<{ readonly host: string; readonly port: number }>;
  readonly deps: HubServerDeps;
  readonly result: HubServerResult;
}>;

/**
 * The listening side of the hub.
 *
 * The hub is the RPC *server* even though apps dial it — see `protocol.ts` for
 * why. Practically that means this node owns a Bun HTTP server, an
 * `HttpRouter` with one websocket route, and the RPC handler layer; all three
 * hang off a single scope so `release` is one call.
 *
 * The handlers close over the `attachments` dependency *node*, not its result.
 * Every mutation therefore goes through an action, which the cell actor
 * serializes — a burst of concurrent `Ingest` calls from several apps cannot
 * interleave halfway through an update.
 */
export class HubServerNode extends NodeBase<HubServerSpec> {
  static readonly spec = resourceSpec.effect<HubServerSpec>({
    tag: tag("hub/server"),
    key: (args) => Key.structure({ host: args.host, port: args.port }),
    dependencies: dependencies((args: HubConfigArgs) => ({
      config: dep(HubConfigNode, {
        host: args.host,
        port: args.port,
        selfInstanceId: args.selfInstanceId,
      }),
      attachments: dep(AttachmentsNode, Args.none),
    })),
    acquire: Driver.Acquire((ctx) =>
      Effect.gen(function* () {
        const config = ctx.deps.config.result;
        const attachments = ctx.deps.attachments;

        const handlers = FrondHubRpcs.toLayer({
          /**
           * The stream's lifetime is the attachment's lifetime. There is no
           * detach message and there should not be one: a crashed app cannot
           * send it, so detachment is learned from the socket dying, which
           * interrupts this handler and fires the `ensuring` below.
           */
          "Frond.Attach": (payload) =>
            Stream.unwrap(
              Effect.gen(function* () {
                if (payload.info.protocolVersion !== HUB_PROTOCOL_VERSION) {
                  return yield* new HubRejection({
                    reason: protocolMismatch(payload.info.protocolVersion),
                  });
                }

                const attachmentId = crypto.randomUUID();
                const connectedAt = yield* Clock.currentTimeMillis;

                // The query mailbox. Unbounded because the broker caps how many
                // queries one attachment may have outstanding, so the queue
                // cannot grow past that cap however unresponsive the app is.
                const outbound = yield* Queue.unbounded<HubCommand>();

                yield* Effect.orDie(
                  attachments.attached(attachmentId, payload.info, connectedAt, outbound)
                );

                const accepted: HubCommand = {
                  _tag: "Attached",
                  attachmentId,
                  values: HUB_REQUESTED_VALUES,
                };

                // Loopback sockets do not idle out, but a half-open socket
                // only surfaces on a write. The heartbeat is that write.
                const heartbeat = Stream.tick(HEARTBEAT_INTERVAL).pipe(
                  Stream.mapEffect(() =>
                    Effect.map(Clock.currentTimeMillis, (at): HubCommand => ({ _tag: "Ping", at }))
                  )
                );

                // `Attached` is concatenated ahead of the merge rather than
                // merged into it, and that ordering is load-bearing: the app
                // learns its own `attachmentId` from that command and cannot
                // reply to a query without one. Concatenation is what
                // guarantees no query can overtake it.
                return Stream.concat(
                  Stream.make(accepted),
                  Stream.merge(heartbeat, Stream.fromQueue(outbound))
                ).pipe(Stream.ensuring(Effect.ignore(attachments.detached(attachmentId))));
              })
            ),
          "Frond.Ingest": (payload) =>
            Effect.orDie(
              attachments.ingested(payload.attachmentId, payload.records, payload.droppedSince)
            ),
          /**
           * The other half of a `Query` command.
           *
           * A unary call rather than a message on some app-to-hub stream,
           * because the app is the RPC client and this is the only direction
           * that gets to make calls. The broker matches it back to whoever is
           * waiting; an answer nobody is waiting for is dropped there, which is
           * what a query that already timed out looks like on arrival.
           */
          "Frond.Reply": (payload) =>
            Effect.orDie(
              attachments.replied(payload.attachmentId, payload.requestId, payload.outcome)
            ),
        });

        const serverLayer = HttpRouter.serve(
          Layer.merge(
            RpcServer.layerHttp({
              group: FrondHubRpcs,
              path: HUB_ATTACH_PATH,
              protocol: "websocket",
            }).pipe(Layer.provide(handlers), Layer.provide(RpcSerialization.layerNdjson)),
            // Same router, same port, same process, one path over. The MCP
            // reader answers from state this node already holds, so giving it
            // its own listener would only add a second thing to shut down.
            mcpLayer({
              attachments,
              selfInstanceId: ctx.args.selfInstanceId,
              version: HUB_VERSION,
            })
          ),
          // Ink owns the terminal; anything written straight to stdout tears
          // through the rendered frame.
          { disableListenLog: true, disableLogger: true }
        ).pipe(
          Layer.provide(
            BunHttpServer.layer({
              hostname: config.host,
              port: config.port,
              // Bun's `server.stop()` resolves only once every connection is
              // gone, and an attachment is a socket that stays open by design.
              // Without a short bound here, shutting the hub down would wait on
              // the apps it is observing.
              gracefulShutdownTimeout: "1 second",
            })
          )
        );

        const serverScope = yield* Scope.make();

        return yield* Effect.onError(
          Effect.gen(function* () {
            yield* Layer.buildWithScope(serverLayer, serverScope);

            yield* Effect.tryPromise(async () => {
              await mkdir(dirname(config.lockfilePath), { recursive: true });
              await writeFile(
                config.lockfilePath,
                `${JSON.stringify(
                  {
                    protocolVersion: HUB_PROTOCOL_VERSION,
                    attachUrl: config.attachUrl,
                    host: config.host,
                    port: config.port,
                    pid: process.pid,
                  },
                  undefined,
                  2
                )}\n`,
                { encoding: "utf8", mode: 0o600 }
              );
            });

            const startedAt = yield* Clock.currentTimeMillis;

            return {
              attachUrl: config.attachUrl,
              host: config.host,
              port: config.port,
              lockfilePath: config.lockfilePath,
              startedAt,
              serverScope,
            };
          }),
          // A failed lockfile write must not leave a listening socket behind:
          // the port would stay held by a node that never reached ready.
          () => Scope.close(serverScope, Exit.void)
        );
      })
    ),
    release: Driver.Release((ctx) => {
      // Read once, up front. Everything below has to survive the socket
      // teardown, and reaching back through `ctx.node` mid-release makes the
      // cleanup depend on a node that is in the middle of ceasing to exist.
      const { serverScope, lockfilePath } = ctx.node.result;

      return Effect.uninterruptible(
        Effect.gen(function* () {
          // Bounded, and deliberately not fatal on expiry: a hub that refuses
          // to release because an attached app will not let go of its socket is
          // a worse failure than a socket that outlives its finalizer.
          //
          // `Effect.exit` rather than a bare yield because shutting down with a
          // live attachment interrupts the websocket handler, and that
          // interrupt comes back out of `Scope.close` as the close's own
          // outcome. Letting it propagate would abandon the release halfway —
          // which is exactly how the lockfile came to outlive the hub that
          // wrote it.
          yield* Effect.exit(
            Effect.timeoutOrElse(Scope.close(serverScope, Exit.void), {
              duration: SHUTDOWN_TIMEOUT,
              orElse: () => Effect.void,
            })
          );

          // A lockfile that outlives its hub sends the next reader to a dead
          // port.
          yield* Effect.ignore(Effect.promise(() => rm(lockfilePath, { force: true })));
        })
      );
    }),
  });

  get attachUrl(): string {
    return this.result.attachUrl;
  }
}
