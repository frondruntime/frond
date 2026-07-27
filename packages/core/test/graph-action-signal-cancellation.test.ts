import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import { Driver, Key, NodeBase, type NodeSpec, serviceSpec, tag, unwrapEffect } from "../src";
import { FrondRuntimeInvariantViolation } from "../src/runtime";
import { createFrondTestHarness } from "../src/testing";

// Caller cancellation for Promise-facing action calls: `metadata.signal` on
// `handle.action` interrupts the submission exactly as if the caller's Effect
// fiber were interrupted. These tests mirror the graph-interruption suite:
// gates and probes, not sleeps.

// Records whether a running action observed its operation AbortSignal firing,
// and lets the test await the moment the action has started (and registered
// the listener).
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

function makeGate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected the promise to reject");
  } catch (cause) {
    return cause;
  }
}

function expectInterruptedCause(rejection: unknown): void {
  // The cancelled call settles with Effect interruption; `unwrapEffect`
  // rejects with the interrupted Cause (never a typed failure).
  if (!Cause.isCause(rejection)) {
    throw new Error(`Expected an interrupted Cause rejection, received ${String(rejection)}`);
  }

  expect(Cause.hasInterruptsOnly(rejection)).toBe(true);
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("action caller cancellation via metadata.signal", () => {
  test("an already-aborted signal settles as interruption without submitting", async () => {
    let invocations = 0;

    type QuickSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly ping: Driver.ActionContract<void, string> };
    }>;

    class QuickNode extends NodeBase<QuickSpec> {
      static readonly spec = serviceSpec.effect<QuickSpec>({
        tag: tag("signal-cancel/already-aborted"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          ping: Driver.Action(() =>
            Effect.sync(() => {
              invocations += 1;
              return "pong";
            })
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(QuickNode, {});
    await handle.ensureReady();
    const eventCountBefore = harness.events.length;

    const controller = new AbortController();
    controller.abort();

    const rejection = await rejectionOf(
      unwrapEffect(handle.action("ping", undefined, { signal: controller.signal }))
    );

    expectInterruptedCause(rejection);
    expect(invocations).toBe(0);
    // Nothing was submitted: no action events were recorded at all.
    expect(harness.events.length).toBe(eventCountBefore);

    // The handle stays usable after the pre-submission cancellation.
    const result = await unwrapEffect(handle.action("ping"));
    expect(result).toMatchObject({ _tag: "Success", value: "pong" });
    expect(invocations).toBe(1);

    await harness.teardown();
  });

  test("aborting a queued action settles it without invoking the driver and the queue proceeds", async () => {
    const startedIds: Array<string> = [];
    const probe = makeAbortProbe();
    const gate = makeGate();

    type QueueSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: {
        readonly wait: Driver.ActionContract<{ readonly id: string }, string>;
      };
    }>;

    class QueueNode extends NodeBase<QueueSpec> {
      static readonly spec = serviceSpec.effect<QueueSpec>({
        tag: tag("signal-cancel/queued"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          // Default admission is "queue": each caller owns its actor task, and
          // tasks serialize on the cell — the second call waits for the first.
          wait: Driver.Action((_ctx, input: { readonly id: string }) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                startedIds.push(input.id);
                probe.markStarted();
              });
              yield* Effect.promise(() => gate.opened);
              return input.id;
            })
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(QueueNode, {});
    await handle.ensureReady();

    const first = unwrapEffect(handle.action("wait", { id: "first" }));
    await probe.started;

    const controller = new AbortController();
    const cancelled = unwrapEffect(
      handle.action("wait", { id: "cancelled" }, { signal: controller.signal })
    );
    // Let the cancelled call enqueue behind the running one before aborting.
    await nextTick();

    controller.abort();
    expectInterruptedCause(await rejectionOf(cancelled));

    // The queue keeps flowing: the first caller still gets its result, and the
    // cancelled operation never reached the driver.
    gate.release();
    await expect(first).resolves.toMatchObject({ _tag: "Success", value: "first" });
    expect(startedIds).toEqual(["first"]);

    await harness.teardown();
  });

  test("aborting an active action fires ctx.signal, settles the phase, and later work runs", async () => {
    const probe = makeAbortProbe();

    type ActiveSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: {
        readonly wait: Driver.ActionContract<void, string>;
        readonly quick: Driver.ActionContract<void, string>;
      };
    }>;

    class ActiveNode extends NodeBase<ActiveSpec> {
      static readonly spec = serviceSpec.effect<ActiveSpec>({
        tag: tag("signal-cancel/active"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          wait: Driver.Action((ctx) =>
            Effect.gen(function* () {
              probe.onAbort(ctx.signal);
              yield* Effect.sync(() => probe.markStarted());
              yield* Effect.never;
              return "done";
            })
          ),
          quick: Driver.Action(() => Effect.succeed("quick")),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(ActiveNode, {});
    await handle.ensureReady();

    const controller = new AbortController();
    const cancelled = unwrapEffect(handle.action("wait", undefined, { signal: controller.signal }));
    await probe.started;
    expect(probe.aborted).toBe(false);

    controller.abort();
    expectInterruptedCause(await rejectionOf(cancelled));

    // Aborting the caller signal interrupts the worker, which runs the
    // action's onInterrupt -> abortController.abort() (ctx.signal fires).
    expect(probe.aborted).toBe(true);

    // The operation phase settles (Idle) and subsequent work runs normally.
    const quick = await unwrapEffect(handle.action("quick"));
    expect(quick).toMatchObject({ _tag: "Success", value: "quick" });

    const snapshot = await harness.runtime.getSnapshot();
    const node = snapshot.graph.nodes.find((entry) => entry.tag === "signal-cancel/active");
    expect(node?.operation).toEqual({ _tag: "Idle" });

    await harness.teardown();
  });

  test("a joined action keeps running for other awaiters when one caller aborts", async () => {
    const probe = makeAbortProbe();
    const gate = makeGate();
    let starts = 0;

    type JoinSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: {
        readonly wait: Driver.ActionContract<{ readonly id: string }, string>;
      };
    }>;

    class JoinNode extends NodeBase<JoinSpec> {
      static readonly spec = serviceSpec.effect<JoinSpec>({
        tag: tag("signal-cancel/join"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          // Join admission shares one in-flight operation across awaiters, so
          // a caller's abort must not cancel the shared work.
          wait: Driver.Action(
            (ctx, _input: { readonly id: string }) =>
              Effect.gen(function* () {
                probe.onAbort(ctx.signal);
                yield* Effect.sync(() => {
                  starts += 1;
                  probe.markStarted();
                });
                yield* Effect.promise(() => gate.opened);
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

    const controller = new AbortController();
    const leaving = unwrapEffect(
      handle.action("wait", { id: "shared" }, { signal: controller.signal })
    );
    await probe.started;
    const staying = unwrapEffect(handle.action("wait", { id: "shared" }));
    // Let the second caller join the in-flight run before aborting the first.
    await nextTick();

    controller.abort();
    expectInterruptedCause(await rejectionOf(leaving));

    // The shared worker keeps running for the other awaiter; its ctx.signal
    // must not have aborted, and the run stays single-flight.
    expect(probe.aborted).toBe(false);
    expect(starts).toBe(1);

    gate.release();
    await expect(staying).resolves.toMatchObject({ _tag: "Success", value: "done" });
    expect(probe.aborted).toBe(false);

    await harness.teardown();
  });

  test("runtime stop during a signal-cancelled operation stays clean", async () => {
    const probe = makeAbortProbe();

    type StopSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly wait: Driver.ActionContract<void, string> };
    }>;

    class StopNode extends NodeBase<StopSpec> {
      static readonly spec = serviceSpec.effect<StopSpec>({
        tag: tag("signal-cancel/runtime-stop"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
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
    const handle = harness.node(StopNode, {});
    await handle.ensureReady();

    const controller = new AbortController();
    const cancelled = unwrapEffect(handle.action("wait", undefined, { signal: controller.signal }));
    await probe.started;

    // Abort and stop without awaiting the settle in between: runtime stop
    // remains authoritative and the caller still sees a clean interruption.
    controller.abort();
    const stopped = harness.teardown();

    expectInterruptedCause(await rejectionOf(cancelled));
    await stopped;
  });

  test("a non-AbortSignal metadata.signal is rejected synchronously", async () => {
    type QuickSpec = NodeSpec<{
      readonly mode: "effect";
      readonly key: Key.Singleton;
      readonly result: { readonly ready: true };
      readonly actions: { readonly ping: Driver.ActionContract<void, string> };
    }>;

    class QuickNode extends NodeBase<QuickSpec> {
      static readonly spec = serviceSpec.effect<QuickSpec>({
        tag: tag("signal-cancel/invalid-signal"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          ping: Driver.Action(() => Effect.succeed("pong")),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(QuickNode, {});
    await handle.ensureReady();

    expect(() => handle.action("ping", undefined, { signal: "abort" as never })).toThrow(
      FrondRuntimeInvariantViolation
    );

    await harness.teardown();
  });
});
