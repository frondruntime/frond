import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { isObservableObject, observable } from "mobx";
import { Args, Driver, Key, NodeBase, type NodeSpec, serviceSpec, tag } from "../src";
import type { ActionContract } from "../src/node";
import { createFrondTestHarness } from "../src/testing";

// `patchResult` staging clones the current result so a FAILED operation rolls
// back without a trace. That isolation must hold against results whose own
// properties are not plain data slots:
//
// - an own enumerable ACCESSOR carried by reference would route staged writes
//   through the original setter into committed state, so staging snapshots the
//   getter value into a writable data slot instead;
// - a MobX observable object masquerades as a plain object while forwarding
//   every property into its shared `$mobx` administration, so it takes the
//   documented non-plain contract: authors choose staging semantics through
//   `resultPatch.nonPlainClone`, and without it the patch fails loudly.

type AccessorResult = { value: number };

type AccessorSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: AccessorResult;
  readonly actions: {
    readonly patchThenFail: ActionContract<void, never>;
    readonly patchAndCommit: ActionContract<void, void>;
  };
}>;

type ObservableResult = { count: number };

type ObservableSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: ObservableResult;
  readonly actions: {
    readonly patchThenFail: ActionContract<void, never>;
    readonly patchAndCommit: ActionContract<void, void>;
  };
}>;

describe("patchResult staged clone rollback isolation", () => {
  test("a failed patch cannot write through an own enumerable accessor into committed state", async () => {
    let shared = 0;
    const makeAccessorResult = (): AccessorResult => {
      const result = {};
      Object.defineProperty(result, "value", {
        enumerable: true,
        configurable: true,
        get: () => shared,
        set: (next: number) => {
          shared = next;
        },
      });
      return result as AccessorResult;
    };

    class AccessorNode extends NodeBase<AccessorSpec> {
      static readonly spec = serviceSpec.effect<AccessorSpec>({
        tag: tag("patch-clone/accessor-rollback"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.sync(makeAccessorResult)),
        actions: {
          patchThenFail: Driver.Action((ctx) =>
            Effect.gen(function* () {
              yield* ctx.patchResult((current) => {
                current.value = 99;
              });
              return yield* Effect.fail({ _tag: "PatchRejected" });
            })
          ),
          patchAndCommit: Driver.Action((ctx) =>
            ctx.patchResult((current) => {
              current.value = 5;
            })
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(AccessorNode, Args.none);
    await handle.ensureReady();

    const failed = await Effect.runPromise(handle.actions.patchThenFail());
    expect(failed._tag).toBe("Failure");

    // The staged mutation never reached the accessor's backing state and the
    // committed result still reads the untouched value.
    expect(shared).toBe(0);
    expect(harness.readReady(handle).result.value).toBe(0);

    // A successful patch commits the isolated snapshot: the new value lands on
    // the committed result while the original accessor plumbing stays silent.
    const committed = await Effect.runPromise(handle.actions.patchAndCommit());
    expect(committed._tag).toBe("Success");
    expect(harness.readReady(handle).result.value).toBe(5);
    expect(shared).toBe(0);

    await harness.teardown();
  });

  test("a failed patch on a MobX observable result leaves the committed observable untouched", async () => {
    const original = observable({ count: 0 });

    class ObservableFailNode extends NodeBase<ObservableSpec> {
      static readonly spec = serviceSpec.effect<ObservableSpec>({
        tag: tag("patch-clone/observable-rollback"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed(original)),
        actions: {
          patchThenFail: Driver.Action((ctx) =>
            Effect.gen(function* () {
              yield* ctx.patchResult((current) => {
                current.count = 42;
              });
              return yield* Effect.fail({ _tag: "PatchRejected" });
            })
          ),
          patchAndCommit: Driver.Action((ctx) =>
            ctx.patchResult((current) => {
              current.count += 1;
            })
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(ObservableFailNode, Args.none);
    await handle.ensureReady();

    const failed = await Effect.runPromise(handle.actions.patchThenFail());
    expect(failed._tag).toBe("Failure");

    // The failed action never leaked its staged write into the observable.
    expect(original.count).toBe(0);
    expect(harness.readReady(handle).result.count).toBe(0);

    await harness.teardown();
  });

  test("without nonPlainClone a patch on an observable result fails loudly instead of committing a fake observable", async () => {
    const original = observable({ count: 0 });

    class ObservableStrictNode extends NodeBase<ObservableSpec> {
      static readonly spec = serviceSpec.effect<ObservableSpec>({
        tag: tag("patch-clone/observable-strict"),
        key: () => Key.singleton(),
        acquire: Driver.Acquire(() => Effect.succeed(original)),
        actions: {
          patchThenFail: Driver.Action((ctx) =>
            Effect.gen(function* () {
              yield* ctx.patchResult((current) => {
                current.count = 42;
              });
              return yield* Effect.fail({ _tag: "PatchRejected" });
            })
          ),
          patchAndCommit: Driver.Action((ctx) =>
            ctx.patchResult((current) => {
              current.count += 1;
            })
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(ObservableStrictNode, Args.none);
    await handle.ensureReady();

    // Observables take the documented non-plain contract: no nonPlainClone
    // means the patch is rejected, the action fails, and the committed result
    // is still the untouched, REAL observable.
    const result = await Effect.runPromise(handle.actions.patchAndCommit());
    expect(result._tag).toBe("Failure");

    const after = harness.readReady(handle).result;
    expect(after).toBe(original);
    expect(isObservableObject(after)).toBe(true);
    expect(after.count).toBe(0);

    await harness.teardown();
  });

  test('with nonPlainClone "share" a committed patch keeps the same real observable instance', async () => {
    const original = observable({ count: 0 });

    class ObservableSharedNode extends NodeBase<ObservableSpec> {
      static readonly spec = serviceSpec.effect<ObservableSpec>({
        tag: tag("patch-clone/observable-shared"),
        key: () => Key.singleton(),
        resultPatch: { nonPlainClone: "share" },
        acquire: Driver.Acquire(() => Effect.succeed(original)),
        actions: {
          patchThenFail: Driver.Action((ctx) =>
            Effect.gen(function* () {
              yield* ctx.patchResult((current) => {
                current.count = 42;
              });
              return yield* Effect.fail({ _tag: "PatchRejected" });
            })
          ),
          patchAndCommit: Driver.Action((ctx) =>
            ctx.patchResult((current) => {
              current.count += 1;
            })
          ),
        },
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(ObservableSharedNode, Args.none);
    await handle.ensureReady();

    const committed = await Effect.runPromise(handle.actions.patchAndCommit());
    expect(committed._tag).toBe("Success");

    // Author opted into shared-reference staging: the committed result is the
    // very same observable — never a plain pseudo-observable carrying a
    // foreign $mobx slot.
    const after = harness.readReady(handle).result;
    expect(after).toBe(original);
    expect(isObservableObject(after)).toBe(true);
    expect(after.count).toBe(1);

    await harness.teardown();
  });
});
