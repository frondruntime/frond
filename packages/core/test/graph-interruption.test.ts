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
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly wait: Driver.ActionContract<void, string> };
    }>;

    class WaitNode extends NodeBase<WaitSpec, "effect"> {
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
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly wait: Driver.ActionContract<{ readonly id: string }, string> };
    }>;

    class JoinNode extends NodeBase<JoinSpec, "effect"> {
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
});
