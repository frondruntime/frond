import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  type RuntimeSink,
  serviceSpec,
  unwrapEffect,
} from "../src/index";

type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: { readonly act: ActionContract<void, void> };
}>;

function gatedActionStartSink() {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const state = { finalized: false, gated: false, release: () => {} };
  const sink: RuntimeSink = {
    name: "gated-action-start",
    // Only the first action start is held.
    handle: (record) =>
      record.event._tag === "GraphActionStarted" && !state.gated
        ? Effect.callback<void>((resume) => {
            state.gated = true;
            state.release = () => resume(Effect.void);
            started.resolve();
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                state.finalized = true;
                finished.resolve();
              })
            )
          )
        : Effect.void,
  };
  return { sink, started: started.promise, finished: finished.promise, state };
}

test("runtime stop interrupts and finalizes a pending action-start sink", async () => {
  let driverRuns = 0;
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "sinks/stop-interrupts",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => 0),
      actions: {
        act: Driver.Action(() => {
          driverRuns += 1;
        }),
      },
    });
  }
  const gate = gatedActionStartSink();
  const runtime = createRuntime({ sinks: [gate.sink] });
  try {
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    const action = handle.actions.act();
    await gate.started;
    await runtime.submit({ _tag: "RuntimeStop" });
    expect(await action).toMatchObject({ _tag: "Failure" });
    expect(gate.state.finalized).toBe(true);
    expect(driverRuns).toBe(0);
  } finally {
    gate.state.release();
    await gate.finished;
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 2000);

test("an aborted action caller interrupts and finalizes its pending start sink", async () => {
  let driverRuns = 0;
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "sinks/abort-interrupts",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => 0),
      actions: {
        act: Driver.Action(() => {
          driverRuns += 1;
        }),
      },
    });
  }
  const gate = gatedActionStartSink();
  const runtime = createRuntime({ sinks: [gate.sink] });
  try {
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    const abort = new AbortController();
    const action = unwrapEffect(handle.action("act", undefined, { signal: abort.signal })).then(
      (value) => value,
      (cause: unknown) => cause
    );
    await gate.started;
    abort.abort();
    await action;
    expect(gate.state.finalized).toBe(true);
    expect(driverRuns).toBe(0);
    // The cell is free again: the next action runs its driver and succeeds.
    expect(await handle.actions.act()).toMatchObject({ _tag: "Success" });
    expect(driverRuns).toBe(1);
    expect(handle.read()._tag).toBe("Ready");
  } finally {
    gate.state.release();
    await gate.finished;
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 2000);

const within = <A>(promise: Promise<A>, ms: number): Promise<"settled" | "timeout"> =>
  Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const
    ),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);

/** Counts errors thrown out of microtasks, which is where an uncaught report lands. */
function captureUncaught() {
  const uncaught: unknown[] = [];
  const original = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (callback) =>
    original(() => {
      try {
        callback();
      } catch (error) {
        uncaught.push(error);
      }
    });
  return { uncaught, restore: () => (globalThis.queueMicrotask = original) };
}

test("runtime stop settles when an interrupted sink's finalizer dies", async () => {
  const capture = captureUncaught();
  try {
    const started = Promise.withResolvers<void>();
    let gated = false;
    const sink: RuntimeSink = {
      name: "dying-completion-sink",
      handle: (record) =>
        record.event._tag === "GraphActionSucceeded" && !gated
          ? Effect.callback<void>(() => {
              gated = true;
              started.resolve();
            }).pipe(Effect.ensuring(Effect.die("sink finalizer died")))
          : Effect.void,
    };
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "sinks/stop-dying-finalizer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => 0),
        actions: { act: Driver.Action(() => {}) },
      });
    }
    const runtime = createRuntime({ sinks: [sink] });
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    const action = handle.actions.act();
    await started.promise;
    expect(await within(runtime.submit({ _tag: "RuntimeStop" }), 1000)).toBe("settled");
    expect(await within(action, 200)).toBe("settled");
    // As in 0.5, the cause of a sink the stop interrupted is not reported.
    expect(capture.uncaught).toEqual([]);
  } finally {
    capture.restore();
  }
}, 5000);

test("runtime stop interrupts every pending sink when one's finalizer dies", async () => {
  const capture = captureUncaught();
  try {
    const parked = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let parkedCount = 0;
    let secondFinalized = false;
    const sink: RuntimeSink = {
      name: "two-completion-sinks",
      handle: (record) => {
        if (record.event._tag !== "GraphActionSucceeded" || parkedCount >= 2) return Effect.void;
        const index = parkedCount;
        parkedCount += 1;
        const park = Effect.callback<void>(() => {
          parked[index]?.resolve();
        });
        return index === 0
          ? park.pipe(Effect.ensuring(Effect.die("first sink finalizer died")))
          : park.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  secondFinalized = true;
                })
              )
            );
      },
    };
    const makeResource = (tag: string) =>
      class Resource extends NodeBase<Spec> {
        static readonly spec = serviceSpec.async<Spec>({
          tag,
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          acquire: Driver.Acquire(() => 0),
          actions: { act: Driver.Action(() => {}) },
        });
      };
    const runtime = createRuntime({ sinks: [sink] });
    const first = runtime.client.node(makeResource("sinks/stop-first"), {});
    const second = runtime.client.node(makeResource("sinks/stop-second"), {});
    await first.ensureReadyNode();
    await second.ensureReadyNode();
    const firstAction = first.actions.act();
    await parked[0]?.promise;
    const secondAction = second.actions.act();
    await parked[1]?.promise;
    const stop = await within(runtime.submit({ _tag: "RuntimeStop" }), 1000);
    expect({
      stop,
      secondFinalized,
      firstAction: await within(firstAction, 200),
      secondAction: await within(secondAction, 200),
      uncaught: capture.uncaught.length,
    }).toEqual({
      stop: "settled",
      secondFinalized: true,
      firstAction: "settled",
      secondAction: "settled",
      uncaught: 0,
    });
  } finally {
    capture.restore();
  }
}, 5000);
