// 0.6 intended change: fixes a 0.5 bug — an action aborted while a pre-driver sink runs ends its operation instead of reading busy forever.
import { expect, test } from "bun:test";
import { Cause, Effect } from "effect";
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

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeResource(tag: string, onDriver: () => void) {
  return class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => 0),
      actions: { act: Driver.Action(onDriver) },
    });
  };
}

/**
 * Parks the first event the predicate accepts after the first action start,
 * optionally with a finalizer that dies when the park is interrupted.
 */
function parkingSink(event: "GraphActionStarted" | "GraphNodeChanged", finalizerDies = false) {
  const parked = Promise.withResolvers<void>();
  const state = { actionStarted: false, gated: false, release: () => {} };
  const sink: RuntimeSink = {
    name: `park-${event}`,
    handle: (record) => {
      const tag = record.event._tag;
      if (tag === "GraphActionStarted") state.actionStarted = true;
      if (state.gated || tag !== event || !state.actionStarted) return Effect.void;
      state.gated = true;
      const park = Effect.callback<void>((resume) => {
        state.release = () => resume(Effect.void);
        parked.resolve();
      });
      return finalizerDies ? park.pipe(Effect.ensuring(Effect.die("sink finalizer died"))) : park;
    },
  };
  return { sink, parked: parked.promise, state };
}

const operationState = (handle: { read(): unknown }) => {
  const read = handle.read() as {
    readonly _tag: string;
    readonly busy?: boolean;
    readonly operation?: { readonly _tag: string };
    readonly operationFailure?: {
      readonly kind: string;
      readonly error: { readonly _tag: string; readonly cancellation?: { readonly _tag: string } };
    };
  };
  return {
    tag: read._tag,
    busy: read.busy,
    operation: read.operation?._tag,
    failureKind: read.operationFailure?.kind,
    failure: read.operationFailure?.error._tag,
    cancellation: read.operationFailure?.error.cancellation?._tag,
  };
};

// The same state an action aborted inside its driver leaves.
const endedByAbort = {
  tag: "Ready",
  busy: false,
  operation: "Idle",
  failureKind: "action",
  failure: "NodeEvicted",
  cancellation: "Interrupted",
};

for (const event of ["GraphActionStarted", "GraphNodeChanged"] as const) {
  test(`an action aborted during its ${event} sink ends its operation`, async () => {
    let driverRuns = 0;
    const Resource = makeResource(`action-sink-abort/${event}`, () => {
      driverRuns += 1;
    });
    const gate = parkingSink(event);
    const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [gate.sink] });
    try {
      const handle = runtime.client.node(Resource, {});
      await handle.ensureReadyNode();
      const abort = new AbortController();
      const action = unwrapEffect(handle.action("act", undefined, { signal: abort.signal })).then(
        () => "resolved",
        () => "rejected"
      );
      await gate.parked;
      abort.abort();
      expect(await action).toBe("rejected");
      await macrotask();
      expect(operationState(handle)).toEqual(endedByAbort);
      gate.state.release();
      await macrotask();
      expect(operationState(handle)).toEqual(endedByAbort);
      expect(driverRuns).toBe(0);
      expect(await handle.actions.act()).toMatchObject({ _tag: "Success" });
      expect(driverRuns).toBe(1);
      const after = operationState(handle);
      expect({ busy: after.busy, operation: after.operation }).toEqual({
        busy: false,
        operation: "Idle",
      });
    } finally {
      gate.state.release();
      await runtime.submit({ _tag: "RuntimeStop" });
    }
  }, 5000);
}

test("an action aborted during a start sink whose finalizer dies rejects with an interruption", async () => {
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
  let driverRuns = 0;
  const Resource = makeResource("action-sink-abort/dying-finalizer", () => {
    driverRuns += 1;
  });
  const gate = parkingSink("GraphActionStarted", true);
  const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [gate.sink] });
  try {
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    const abort = new AbortController();
    const action = unwrapEffect(handle.action("act", undefined, { signal: abort.signal })).then(
      () => "resolved",
      (cause: unknown) =>
        Cause.isCause(cause) && Cause.hasInterruptsOnly(cause) ? "interrupted" : "other"
    );
    await gate.parked;
    abort.abort();
    expect(await action).toBe("interrupted");
    await macrotask();
    expect(operationState(handle)).toEqual(endedByAbort);
    expect(await handle.actions.act()).toMatchObject({ _tag: "Success" });
    expect(driverRuns).toBe(1);
    expect(uncaught).toEqual([]);
  } finally {
    globalThis.queueMicrotask = original;
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 5000);
