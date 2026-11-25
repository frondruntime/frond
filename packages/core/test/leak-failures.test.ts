import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import {
  type ActionContract,
  createRuntime,
  Driver,
  Graph,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "../src";
import { leakSlackPerRound, liveSample, objectGrowth } from "./leakTestFixtures";

type FailureSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: { rows: Array<{ value: number }> };
  readonly actions: {
    readonly fail: ActionContract<number>;
    readonly interrupt: ActionContract<{ readonly staged: (signal: AbortSignal) => void }>;
  };
}>;

class FailureNode extends NodeBase<FailureSpec> {
  static readonly spec = resourceSpec.async<FailureSpec>({
    tag: tag("test/core/leak-failures/resource"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => ({ rows: [{ value: 0 }] })),
    refresh: Driver.Refresh((context) => {
      context.patchResult((current) => {
        current.rows.push({ value: -1 });
      });
      throw new Error("Expected refresh failure");
    }),
    actions: {
      fail: Driver.Action((context, value) => {
        context.patchResult((current) => {
          current.rows.push({ value });
        });
        throw new Error("Expected action failure");
      }),
      interrupt: Driver.Action(async (context, input) => {
        context.patchResult((current) => {
          current.rows.push({ value: -2 });
        });
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
          input.staged(context.signal);
        });
        throw new Error("Interrupted action unexpectedly resumed");
      }),
    },
  });
}

test("failed and interrupted operations release drafts and bound retained failures", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const failures = liveSample();
  try {
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(FailureNode, {});
    if ((await handle.ensureReady())._tag !== "Ready") throw new Error("Node did not become ready");
    const node = handle.readReady();
    const round = async (index: number, track: boolean) => {
      const action = await handle.actions.fail(index);
      if (
        action._tag !== "Failure" ||
        !(action.error.cause instanceof Graph.DriverPromiseFailed) ||
        !(action.error.cause.cause instanceof Error) ||
        action.error.cause.cause.message !== "Expected action failure"
      )
        throw new Error("Action did not fail through its expected channel");
      const refresh = await handle.refresh();
      if (
        refresh._tag !== "Failure" ||
        !(refresh.error.cause instanceof Graph.DriverPromiseFailed) ||
        !(refresh.error.cause.cause instanceof Error) ||
        refresh.error.cause.cause.message !== "Expected refresh failure"
      )
        throw new Error("Refresh did not fail through its expected channel");
      if (track) {
        failures.track(action.error);
        failures.track(refresh.error);
      }
      const staged = Promise.withResolvers<AbortSignal>();
      const fiber = Effect.runFork(handle.action("interrupt", { staged: staged.resolve }));
      const signal = await staged.promise;
      await Effect.runPromise(Fiber.interrupt(fiber));
      if (!signal.aborted) throw new Error("Interrupted action did not abort its driver");
      if ((await handle.ensureReady())._tag !== "Ready") throw new Error("Node lost readiness");
      const read = handle.read();
      if (read._tag !== "Ready" || read.operation._tag !== "Idle" || read.node !== node)
        throw new Error("Interrupted operation did not settle on the original node");
      if (node.result.rows.length !== 1 || node.result.rows[0]?.value !== 0)
        throw new Error("Failed operation committed a staged patch");
    };
    const growth = await objectGrowth((index) => round(index, false));
    for (let index = 0; index < 20; index += 1) await round(10_000 + index, true);
    // eventBus.ts deliberately retains the latest 512 records, including failures.
    // Rotate that bounded history before checking node-owned failure retention.
    for (let index = 0; index < 100; index += 1) await round(20_000 + index, false);
    console.info("L7 failures", JSON.stringify(growth));
    expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
    expect(runtime.getSnapshotSync().events).toHaveLength(512);
    expect(await failures.alive()).toBeLessThanOrEqual(2);
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 120_000);
