// 0.6 intended change: fixes a 0.5 bug — the cancel now ends the operation, so its own GraphNodeChanged follows the abort.
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

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("an action aborted during its start sink starts no further sink of its own", async () => {
  let driverRuns = 0;
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "action-abort/sink-continuation",
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
  const parked = Promise.withResolvers<void>();
  const state = { gated: false, aborted: false, release: () => {} };
  const afterAbort: string[] = [];
  const sink: RuntimeSink = {
    name: "park-first-action-start",
    handle: (record) => {
      if (state.aborted) afterAbort.push(record.event._tag);
      if (state.gated || record.event._tag !== "GraphActionStarted") return Effect.void;
      state.gated = true;
      return Effect.callback<void>((resume) => {
        state.release = () => resume(Effect.void);
        parked.resolve();
      });
    },
  };
  const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [sink] });
  try {
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    const abort = new AbortController();
    const action = unwrapEffect(handle.action("act", undefined, { signal: abort.signal })).then(
      () => "resolved",
      () => "rejected"
    );
    await parked.promise;
    state.aborted = true;
    abort.abort();
    expect(await action).toBe("rejected");
    await macrotask();
    await macrotask();
    // Only the cancel's own events: the interrupted action's failure and the
    // change notice for ending its operation. The interrupted sink's
    // continuation starts no GraphNodeChanged sink of its own.
    expect(afterAbort).toEqual(["GraphActionFailed", "GraphNodeChanged"]);
    expect(driverRuns).toBe(0);
  } finally {
    state.release();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 5000);
