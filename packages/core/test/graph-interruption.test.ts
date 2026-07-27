import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { Driver, Key, NodeBase, type NodeSpec, serviceSpec, tag } from "../src";
import { createFrondTestHarness } from "../src/testing";

// Records whether a running action observed its AbortSignal firing, and lets the
// test await the moment the action has started (and registered the listener).
function makeAbortProbe() {
  let aborted = false;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    started,
    get aborted() {
      return aborted;
    },
    onAbort: (signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
    },
    markStarted,
  };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("action interruption", () => {
  test("a queue action aborts its signal when its awaiter is interrupted", async () => {
    const probe = makeAbortProbe();

    type WaitSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly wait: Driver.ActionContract<void, string> };
    }>;

    class WaitNode extends NodeBase<WaitSpec> {
      static readonly spec = serviceSpec.effect<WaitSpec>({
        tag: tag("interruption/queue"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          // Default admission is "queue": each caller owns its actor task.
          wait: Driver.Action((ctx) =>
            Effect.gen(function* () {
              probe.onAbort(ctx.signal);
              yield* Effect.sync(() => probe.markStarted());
              yield* Effect.never;
              return "done";
            })
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(WaitNode, {});
    await handle.ensureReady();

    const fiber = Effect.runFork(handle.action("wait"));
    await probe.started;
    expect(probe.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));

    // Interrupting the awaiter interrupts the worker, which runs the action's
    // onInterrupt -> abortController.abort().
    expect(probe.aborted).toBe(true);

    await harness.teardown();
  });

  test("a joined action is not aborted when its awaiter is interrupted", async () => {
    const probe = makeAbortProbe();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    type JoinSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly wait: Driver.ActionContract<{ readonly id: string }, string> };
    }>;

    class JoinNode extends NodeBase<JoinSpec> {
      static readonly spec = serviceSpec.effect<JoinSpec>({
        tag: tag("interruption/join"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          // Join admission shares one in-flight operation across awaiters, so an
          // awaiter leaving must not abort the shared work.
          wait: Driver.Action(
            (ctx, _input: { readonly id: string }) =>
              Effect.gen(function* () {
                probe.onAbort(ctx.signal);
                yield* Effect.sync(() => probe.markStarted());
                yield* Effect.promise(() => gate);
                return "done";
              }),
            { admission: "join", admissionKey: (input) => input.id }
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(JoinNode, {});
    await handle.ensureReady();

    const fiber = Effect.runFork(handle.action("wait", { id: "shared" }));
    await probe.started;

    await Effect.runPromise(Fiber.interrupt(fiber));
    await nextTick();

    // The shared worker keeps running; its signal must not have aborted.
    expect(probe.aborted).toBe(false);

    release();
    await harness.teardown();
  });

  test("an unbounded action outlives the runtime action deadline and is still interrupted by RuntimeStop", async () => {
    const probe = makeAbortProbe();

    type UnboundedSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly hang: Driver.ActionContract<void, string> };
    }>;

    class UnboundedNode extends NodeBase<UnboundedSpec> {
      static readonly spec = serviceSpec.effect<UnboundedSpec>({
        tag: tag("interruption/unbounded-timeout"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          hang: Driver.Action(
            (ctx) =>
              Effect.gen(function* () {
                probe.onAbort(ctx.signal);
                yield* Effect.sync(() => probe.markStarted());
                yield* Effect.never;
                return "done";
              }),
            { timeout: "unbounded" }
          ),
        },
      });
    }

    // 20ms runtime action deadline: an inheriting action would time out almost
    // immediately, so surviving well past it pins the unbounded escape.
    const harness = createFrondTestHarness({ driverTimeouts: { action: 20 } });
    await harness.start();
    const handle = harness.node(UnboundedNode, {});
    await handle.ensureReady();

    const fiber = Effect.runFork(handle.action("hang"));
    let settled = false;
    const awaited = Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      settled = true;
      return exit;
    });

    await probe.started;
    // Let several multiples of the 20ms deadline elapse: the unbounded action
    // must be neither timed out nor aborted by the deadline machinery.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    expect(probe.aborted).toBe(false);

    // Runtime stop flows through fiber interruption/close paths, not the
    // deadline, so it must still interrupt the in-flight unbounded action and
    // settle the operation.
    await harness.stop();
    await awaited;

    expect(settled).toBe(true);
    expect(probe.aborted).toBe(true);

    await harness.teardown();
  });
});
