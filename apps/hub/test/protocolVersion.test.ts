import { afterEach, describe, expect, test } from "bun:test";
import { BunHttpServer } from "@effect/platform-bun";
import { createRuntime, type Runtime } from "@frondruntime/core";
import {
  attachDevtools,
  attachLayer,
  FrondHubRpcs,
  HUB_ATTACH_PATH,
  HUB_PROTOCOL_VERSION,
  type HubCommand,
  HubRejection,
} from "@frondruntime/devtools";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { HubServerNode } from "../src/nodes/hubServer.ts";

const HOST = "127.0.0.1";

/**
 * Ports are picked per test: a fixed one turns an unrelated process into a
 * flake. The band is clear of `attach.test.ts`, which binds real sockets from
 * 7500 and would otherwise collide with this file's low end.
 */
let nextPort = 8400 + Math.floor(Math.random() * 400);

function takePort(): number {
  nextPort += 1;
  return nextPort;
}

/** A port nothing is listening on, so every attempt fails at connect. */
const DEAD_URL = "ws://127.0.0.1:1/attach";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) {
    await teardown.pop()?.();
  }
});

async function startedRuntime(): Promise<Runtime.Runtime> {
  const runtime = createRuntime();

  await runtime.submit({ _tag: "RuntimeStart" });

  return runtime;
}

async function startHub(port: number): Promise<string> {
  const runtime = await startedRuntime();
  const handle = runtime.client.node(HubServerNode, {
    host: HOST,
    port,
    selfInstanceId: crypto.randomUUID(),
  });
  const server = await handle.ensureReadyNode();

  teardown.push(async () => {
    await handle.releaseResources("test teardown");
    await runtime.submit({ _tag: "RuntimeStop", reason: "test teardown" });
  });

  return server.result.attachUrl;
}

/**
 * The version the hub refuses, sent by a raw client.
 *
 * `attachRuntime` always sends the version it was compiled against — which is
 * correct, and the reason it cannot exercise this path from either direction.
 */
function dialWithVersion(
  attachUrl: string,
  protocolVersion: number
): Promise<Exit.Exit<unknown, unknown>> {
  return Effect.runPromise(
    Effect.exit(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(FrondHubRpcs);

        return yield* Stream.runCollect(
          client["Frond.Attach"]({
            info: {
              protocolVersion,
              instanceId: crypto.randomUUID(),
              runtimeId: "runtime-1",
              generation: 0,
              name: "probe",
              platform: "bun",
              startedAt: 0,
              values: "shape",
            },
          })
        );
      }).pipe(Effect.scoped, Effect.provide(attachLayer(attachUrl)))
    )
  );
}

function rejectionReason(exit: Exit.Exit<unknown, unknown>): string {
  if (exit._tag === "Success") {
    throw new Error("the hub accepted an attachment it should have refused");
  }

  for (const reason of exit.cause.reasons) {
    if (reason._tag === "Fail" && reason.error instanceof HubRejection) {
      return reason.error.reason;
    }
  }

  throw new Error(`no HubRejection on the cause: ${JSON.stringify(exit.cause)}`);
}

/**
 * A hub that refuses everything, standing in for one the app is too old for.
 *
 * Real layers, real websocket, real ndjson — the same server stack
 * `HubServerNode` builds. A hand-rolled socket would prove the client stops
 * retrying on *something*, not that it stops retrying on a decoded
 * `HubRejection` that travelled the wire it actually uses.
 *
 * Counting the attempts is the point of it: the log line below says the client
 * noticed, and only this says it stopped.
 */
async function startRefusingHub(
  port: number,
  reason: string
): Promise<{ readonly url: string; readonly attempts: () => number }> {
  let attempts = 0;

  const handlers = FrondHubRpcs.toLayer({
    "Frond.Attach": (): Stream.Stream<HubCommand, HubRejection> =>
      Stream.unwrap(
        Effect.suspend(() => {
          attempts += 1;

          return new HubRejection({ reason });
        })
      ),
    "Frond.Ingest": () => Effect.void,
    "Frond.Reply": () => Effect.void,
  });

  const serverLayer = HttpRouter.serve(
    RpcServer.layerHttp({
      group: FrondHubRpcs,
      path: HUB_ATTACH_PATH,
      protocol: "websocket",
    }).pipe(Layer.provide(handlers), Layer.provide(RpcSerialization.layerNdjson)),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provide(
      BunHttpServer.layer({ hostname: HOST, port, gracefulShutdownTimeout: "1 second" })
    )
  );

  const scope = Effect.runSync(Scope.make());

  await Effect.runPromise(Layer.buildWithScope(serverLayer, scope));

  teardown.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  return {
    url: `ws://${HOST}:${port}${HUB_ATTACH_PATH}`,
    attempts: () => attempts,
  };
}

/** Swaps `console.error` for the duration of one test and collects what it saw. */
function captureConsoleError(): () => ReadonlyArray<string> {
  const original = console.error;
  const lines: Array<string> = [];

  console.error = (...args: ReadonlyArray<unknown>) => {
    lines.push(args.map(String).join(" "));
  };

  teardown.push(async () => {
    console.error = original;
  });

  return () => lines;
}

describe("protocol version mismatch", () => {
  /**
   * `"rejected"` used to be the whole message, which named neither version and
   * left the operator with no way to tell which side to upgrade. Both numbers
   * and the direction are the part that makes the line actionable, so they are
   * asserted rather than left to a comment.
   */
  test("the hub names both versions and says the app is behind", async () => {
    const attachUrl = await startHub(takePort());

    const reason = rejectionReason(await dialWithVersion(attachUrl, HUB_PROTOCOL_VERSION - 1));

    expect(reason).toBe(
      `protocol version mismatch: app speaks ${HUB_PROTOCOL_VERSION - 1}, hub speaks ${HUB_PROTOCOL_VERSION}; the app is behind, upgrade @frondruntime/devtools in the app`
    );
    expect(reason).not.toContain("\n");
  });

  test("the hub names both versions and says the hub is behind", async () => {
    const attachUrl = await startHub(takePort());

    const reason = rejectionReason(await dialWithVersion(attachUrl, HUB_PROTOCOL_VERSION + 1));

    expect(reason).toBe(
      `protocol version mismatch: app speaks ${HUB_PROTOCOL_VERSION + 1}, hub speaks ${HUB_PROTOCOL_VERSION}; the hub is behind, upgrade @frondruntime/hub`
    );
    expect(reason).not.toContain("\n");
  });

  /**
   * The failure this whole change is about: a refused app used to redial every
   * two seconds forever, saying nothing, and present as devtools that simply
   * did not work.
   */
  test("a refused attach stops retrying and says so once", async () => {
    const refusal = "protocol version mismatch: app speaks 1, hub speaks 2; the app is behind";
    const hub = await startRefusingHub(takePort(), refusal);
    const logged = captureConsoleError();

    const detach = attachDevtools({ runtime: await startedRuntime(), url: hub.url, name: "app" });

    // Comfortably past several retry delays, so a loop that kept going shows up
    // as more than one attempt rather than as a timing accident.
    await Bun.sleep(5000);

    expect(hub.attempts()).toBe(1);
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toContain(refusal);

    // Terminal or not, the handle is the caller's only way out, and one that
    // threw would be a devtools client taking down the app on the way down.
    detach();
    detach();
  }, 15000);

  /**
   * An app that supplied a handler asked to be the one reporting this. Logging
   * anyway would put the same failure in two places, which is how a devtools
   * client ends up in someone's error budget.
   */
  test("a supplied onError takes over reporting, and it is still terminal", async () => {
    const hub = await startRefusingHub(takePort(), "refused");
    const logged = captureConsoleError();
    const causes: Array<unknown> = [];

    const detach = attachDevtools({
      runtime: await startedRuntime(),
      url: hub.url,
      name: "app",
      onError: (cause) => {
        causes.push(cause);
      },
    });

    await Bun.sleep(5000);

    expect(hub.attempts()).toBe(1);
    expect(causes).toHaveLength(1);
    expect(logged()).toHaveLength(0);

    detach();
  }, 15000);

  /**
   * The regression the terminal path could plausibly cause. A hub that is not
   * running yet is the *normal* state of an attached app, and an app that gave
   * up on it would never reconnect once the developer started one.
   */
  test("an unreachable hub is still retried, not treated as a refusal", async () => {
    const logged = captureConsoleError();
    const causes: Array<unknown> = [];

    const detach = attachDevtools({
      runtime: await startedRuntime(),
      url: DEAD_URL,
      name: "app",
      onError: (cause) => {
        causes.push(cause);
      },
    });

    await Bun.sleep(2500);
    detach();

    expect(causes.length).toBeGreaterThan(1);
    expect(logged()).toHaveLength(0);
  }, 15000);
});
