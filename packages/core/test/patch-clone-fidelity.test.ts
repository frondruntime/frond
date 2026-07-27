import { describe, expect, test } from "bun:test";
import {
  Args,
  type AsyncDriverContext,
  Driver,
  internalOf,
  Key,
  NodeBase,
  type NodeSpec,
  type NodeSpecArgs,
  type NodeSpecResolvedDeps,
  serviceSpec,
  tag,
  type WithInternal,
  withInternal,
} from "../src";
import type { ActionContract } from "../src/node";
import { createFrondTestHarness } from "../src/testing";

// `patchResult` staging clones the current result before running the recipe so
// failed operations roll back. The clone must copy EVERY own property —
// including non-enumerable symbol-keyed slots such as the result envelope's
// internal — or a successful patch silently strips hidden state from the
// committed result and a rollback comparison sees a mutilated object.

type Internal = { readonly controller: AbortController };

type CounterResult = {
  count: number;
  readonly meta: { flavor: string };
};

type CounterActions = {
  readonly bump: ActionContract<void, { readonly count: number }>;
  readonly bumpAndFail: ActionContract<void, never>;
};

type CounterSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: CounterResult;
  readonly actions: CounterActions;
}>;

type CounterContext = AsyncDriverContext<
  NodeBase<CounterSpec>,
  NodeSpecArgs<CounterSpec>,
  NodeSpecResolvedDeps<CounterSpec>,
  CounterResult
>;

const internalState: Internal = { controller: new AbortController() };

const counterActions = {
  bump: Driver.Action((ctx: CounterContext) => {
    ctx.patchResult((current) => {
      current.count += 1;
    });
    return Promise.resolve({ count: 1 });
  }),
  bumpAndFail: Driver.Action((ctx: CounterContext): Promise<never> => {
    ctx.patchResult((current) => {
      current.count += 100;
    });
    return Promise.reject(new Error("bump rejected after staging"));
  }),
};

class CounterNode extends NodeBase<CounterSpec> {
  static readonly spec = serviceSpec.async<CounterSpec, typeof counterActions>({
    tag: tag("patch-clone/counter"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(
      (): CounterResult =>
        withInternal<CounterResult, Internal>(
          { count: 0, meta: { flavor: "plain" } },
          internalState
        )
    ),
    actions: counterActions,
  });
}

function slotOf(result: CounterResult): Internal {
  return internalOf(result as WithInternal<CounterResult, Internal>);
}

describe("patchResult clone fidelity", () => {
  test("a committed patch keeps non-enumerable symbol slots on the cloned result", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(CounterNode, Args.none);
    await handle.ensureReady();

    const before = harness.readReady(handle).result;
    expect(slotOf(before)).toBe(internalState);

    const bumped = await handle.actions.bump();
    expect(bumped._tag).toBe("Success");

    const after = harness.readReady(handle).result;

    // The staged clone was committed (isolation from the pre-patch object)...
    expect(after).not.toBe(before);
    expect(after.count).toBe(1);
    expect(before.count).toBe(0);
    expect(after.meta).not.toBe(before.meta);
    expect(after.meta).toEqual({ flavor: "plain" });

    // ...and it carries the envelope slot with its descriptor intact: present,
    // identical by reference, and still hidden from enumeration/serialization.
    expect(slotOf(after)).toBe(internalState);
    expect(Object.keys(after)).toEqual(["count", "meta"]);
    expect(JSON.stringify(after)).toBe('{"count":1,"meta":{"flavor":"plain"}}');

    await harness.teardown();
  });

  test("a failed patch rolls back to the untouched original, slot included", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(CounterNode, Args.none);
    await handle.ensureReady();

    const original = harness.readReady(handle).result;

    const failed = await handle.actions.bumpAndFail();
    expect(failed._tag).toBe("Failure");

    const rolledBack = harness.readReady(handle).result;

    // Rollback keeps the exact original object: the staged mutation never
    // leaked and the hidden slot never moved.
    expect(rolledBack).toBe(original);
    expect(rolledBack.count).toBe(0);
    expect(slotOf(rolledBack)).toBe(internalState);

    await harness.teardown();
  });
});
