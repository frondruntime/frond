import type { Runtime } from "@frondruntime/core";
import { Clock, Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { encodeRecord } from "./encode.ts";
import { type EncodePolicy, resolvePolicy } from "./policy.ts";
import {
  type AttachmentInfo,
  type EncodedEventRecord,
  FrondHubRpcs,
  HUB_PROTOCOL_VERSION,
  type HubCommand,
  type QueryOutcome,
  type ValuePolicy,
} from "./protocol.ts";
import { encodeGraphSnapshot } from "./snapshot.ts";

/**
 * How many encoded records are held between flushes.
 *
 * When this fills, further records are counted and discarded rather than
 * buffered without bound: an attached app must never be slowed down, let alone
 * grow unboundedly, because a devtools consumer stopped reading. The count
 * travels as `droppedSince`, so the hub always knows a gap happened.
 */
const MAX_BUFFERED_RECORDS = 4096;

const FLUSH_INTERVAL = "250 millis";

export type AttachOptions = {
  readonly runtime: Runtime.Runtime;
  readonly attachUrl: string;
  /** Human label for the hub's list, e.g. the host app's package name. */
  readonly name: string;
  readonly platform: string;
  /**
   * The most this app will ever disclose, whatever the hub asks for.
   *
   * `"shape"` by default: structure, key names, lengths and types, but no
   * values. Sending real values is a decision worth making per app rather than
   * inheriting — the runtimes worth debugging are the ones holding tokens and
   * account state, and a default that ships them is a default that ships them
   * the first time someone forgets.
   */
  readonly values?: ValuePolicy | undefined;
  /**
   * Stable identity for this attachment, unique across processes.
   *
   * Defaults to a fresh UUID, which is right for an ordinary app. The hub sets
   * it explicitly so it can recognise its own self-attachment in the list it
   * serves — `runtimeId` cannot do that job, because it comes from a
   * per-process counter and every runtime's first one is `runtime-1`.
   *
   * Minted per *call*, not per attempt: `attachDevtools` reuses one across
   * reconnects, so an app that outlives a hub restart comes back as itself.
   */
  readonly instanceId?: string;
  /** How many times this runtime has already attached. See `AttachmentInfo`. */
  readonly generation?: number;
  /**
   * Called once the hub has accepted this attempt.
   *
   * Exists so the caller can count reconnections without having to guess from
   * the outside which attempts got as far as being accepted.
   */
  readonly onAttached?: (() => void) | undefined;
  /**
   * Return false to leave a record out of the stream entirely.
   *
   * Distinct from the drop counter below, and the difference matters: a drop is
   * a gap the hub must be told about, because an agent reading the feed has to
   * be able to tell "did not happen" from "was lost". A record excluded here
   * was never in scope, so it is not a gap and is not counted as one.
   *
   * Exists for one caller — the hub, which observes the runtime it is also
   * writing into and would otherwise feed itself forever. An ordinary app has
   * no reason to pass this.
   */
  readonly include?: (record: Runtime.RuntimeEventRecord) => boolean;
};

/**
 * Mints the id that identifies this runtime for the life of the process.
 *
 * Guarded rather than called directly because `crypto.randomUUID` is not
 * everywhere a Frond app runs. React Native has no global `crypto` until a
 * polyfill installs one, and the bare failure — a `TypeError` about `undefined`
 * — surfaces from inside a devtools call the app made once at startup and says
 * nothing about how to proceed. The caller can always supply `instanceId` and
 * skip this entirely, which is the fix this points at.
 */
export function newInstanceId(): string {
  if (typeof crypto?.randomUUID !== "function") {
    throw new Error(
      "attachDevtools needs crypto.randomUUID, which this runtime does not provide. " +
        "React Native reaches this without a polyfill such as react-native-get-random-values. " +
        "Install one before attaching, or pass your own `instanceId` — any string that is " +
        "stable for the life of the process will do."
    );
  }

  return crypto.randomUUID();
}

/**
 * Transport for one attachment.
 *
 * Exported because the hub dials itself over exactly this layer — same
 * protocol, same serialization, same socket code path as a real app. If
 * self-attach works, the transport works.
 */
export function attachLayer(attachUrl: string): Layer.Layer<RpcClient.Protocol> {
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(attachUrl)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerNdjson)
  );
}

/**
 * Streams a runtime's events to a hub for as long as the connection lives.
 *
 * The returned Effect does not settle while attached — it *is* the attachment.
 * Fork it into a scope and close the scope to detach; the hub learns about the
 * detachment from the socket dying, which is the only mechanism that also works
 * when the app crashes.
 */
export const attachRuntime = Effect.fnUntraced(function* (options: AttachOptions) {
  const client = yield* RpcClient.make(FrondHubRpcs);

  const ceiling: ValuePolicy = options.values ?? "shape";

  let buffer: Array<EncodedEventRecord> = [];
  let dropped = 0;
  // Events fire between the socket opening and the `Attached` command arriving,
  // and the conservative reading of an unanswered negotiation is the narrow
  // one. Still clamped, so a ceiling of `"none"` holds from the first record.
  let policy: EncodePolicy = resolvePolicy("shape", ceiling);
  let attachmentId: string | undefined;

  // Encoding happens here, at observe time, not at flush time: a
  // `RuntimeEventRecord` carries live references that keep mutating after the
  // record is handed out, so a record buffered raw would describe the graph as
  // it is when flushed, not as it was when the event fired.
  const subscription = options.runtime.observe((record) => {
    // Before the buffer check, so an excluded record cannot be counted as a
    // drop, and before encoding, so it costs nothing to exclude one.
    if (options.include !== undefined && !options.include(record)) {
      return;
    }

    if (buffer.length >= MAX_BUFFERED_RECORDS) {
      dropped += 1;
      return;
    }

    buffer.push(encodeRecord(record, policy));
  });

  yield* Effect.addFinalizer(() => Effect.sync(() => subscription.unsubscribe()));

  const info: AttachmentInfo = {
    protocolVersion: HUB_PROTOCOL_VERSION,
    instanceId: options.instanceId ?? newInstanceId(),
    runtimeId: options.runtime.getSnapshotSync().runtimeId,
    generation: options.generation ?? 0,
    name: options.name,
    platform: options.platform,
    startedAt: yield* Clock.currentTimeMillis,
    // Advertised so the hub can show what it is going to get. Advisory only:
    // `resolvePolicy` below is what actually enforces it, because a ceiling a
    // sender merely announces is one the sender can forget to apply.
    values: ceiling,
  };

  const flushOnce = Effect.gen(function* () {
    yield* Effect.sleep(FLUSH_INTERVAL);

    const id = attachmentId;

    if (id === undefined || (buffer.length === 0 && dropped === 0)) {
      return;
    }

    // Swapped, not drained: `observe` runs on whatever fiber produced the
    // event, so anything appended during the send lands in the next batch
    // instead of being lost to a splice race.
    const records = buffer;
    const droppedSince = dropped;
    buffer = [];
    dropped = 0;

    yield* client["Frond.Ingest"]({ attachmentId: id, records, droppedSince });
  });

  yield* Effect.forkScoped(Effect.forever(flushOnce));

  /**
   * Answers one query, on its own fiber.
   *
   * Forked rather than awaited inline because this runs on the command stream:
   * a snapshot of a large graph is the most expensive thing this client does,
   * and blocking here would stall the heartbeat and every query behind it
   * behind one slow answer.
   *
   * Nothing in here is allowed to fail outward. A query that throws comes back
   * as `Failed`, because the alternative is an error escaping into the stream
   * handler and taking down an attachment over a question that was only ever
   * advisory.
   */
  const answer = (command: Extract<HubCommand, { readonly _tag: "Query" }>) =>
    Effect.gen(function* () {
      const id = attachmentId;

      if (id === undefined) {
        return;
      }

      const capturedAt = yield* Clock.currentTimeMillis;

      const outcome = yield* Effect.map(
        Effect.exit(
          Effect.sync(() => {
            // Clamped against the ceiling, not against the stream's policy. A
            // deliberate read may ask for more than the firehose gets, and may
            // never ask for more than the app agreed to disclose.
            const requested = resolvePolicy(command.values, ceiling);

            return encodeGraphSnapshot(options.runtime.getSnapshotSync(), {
              policy: requested,
              capturedAt,
              nodeId: command.query._tag === "Node" ? command.query.nodeId : undefined,
            });
          })
        ),
        (exit): QueryOutcome =>
          exit._tag === "Success"
            ? { _tag: "Snapshot", snapshot: exit.value }
            : { _tag: "Failed", reason: failureReason(exit.cause) }
      );

      yield* Effect.ignore(
        client["Frond.Reply"]({ attachmentId: id, requestId: command.requestId, outcome })
      );
    });

  yield* Stream.runForEach(client["Frond.Attach"]({ info }), (command) => {
    if (command._tag === "Attached") {
      return Effect.sync(() => {
        attachmentId = command.attachmentId;
        policy = resolvePolicy(command.values, ceiling);
        options.onAttached?.();
      });
    }

    if (command._tag === "Query") {
      return Effect.forkScoped(answer(command));
    }

    return Effect.void;
  });
});

/**
 * A reason string for a query that could not be answered.
 *
 * Deliberately thin. This travels to a hub that will show it to whoever asked,
 * and the useful cases — an unstarted runtime, a node id that does not resolve —
 * already say so in their message. Serializing a cause chain here would mean a
 * second, competing account of failures next to the one the event stream
 * already carries.
 */
function failureReason(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message === "" ? cause.name : cause.message;
  }

  return String(cause);
}
