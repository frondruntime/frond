import { describe, expect, test } from "bun:test";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  serviceSpec,
} from "../src/index";

/** A thenable that calls back every listed settlement, in order, synchronously. */
function repeatingThenable<A>(
  settlements: ReadonlyArray<{ readonly resolve: A } | { readonly reject: unknown }>
): Promise<A> {
  return {
    // biome-ignore lint/suspicious/noThenProperty: an adversarial driver thenable exercises repeated settlement.
    then(resolve: (value: A) => void, reject: (cause: unknown) => void) {
      for (const settlement of settlements) {
        if ("resolve" in settlement) resolve(settlement.resolve);
        else reject(settlement.reject);
      }
    },
  } as unknown as Promise<A>;
}

describe("a driver thenable that settles more than once", () => {
  test("a live start resolving twice keeps the resource it committed", async () => {
    type Spec = NodeSpec<{
      readonly mode: "async";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;
    const resource = { open: true };
    const stops: string[] = [];
    class Resource extends NodeBase<Spec> {
      static readonly spec = resourceSpec.async<Spec>({
        tag: "edges/double-live-settle",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => "ready"),
        live: Driver.Live({
          start: () => repeatingThenable([{ resolve: resource }, { resolve: resource }]),
          stop: (ctx, value) => {
            value.open = false;
            stops.push(ctx.reason._tag);
          },
        }),
      });
    }
    const runtime = createRuntime();
    const handle = runtime.client.node(Resource, {});
    try {
      await handle.ensureReadyNode();
      expect((await handle.acquireLiveLease("manual", {}))._tag).toBe("Held");
      expect(stops).toEqual([]);
      expect(resource.open).toBe(true);
    } finally {
      await runtime.submit({ _tag: "RuntimeStop" });
    }
    expect(stops).toHaveLength(1);
  });

  test("an action resolving and then rejecting settles once with its first value", async () => {
    type Spec = NodeSpec<{
      readonly mode: "async";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: number;
      readonly actions: { readonly act: ActionContract<void, string> };
    }>;
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "edges/resolve-then-reject",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => 1),
        actions: {
          act: Driver.Action(() =>
            repeatingThenable<string>([{ resolve: "first" }, { reject: new Error("late") }])
          ),
        },
      });
    }
    const runtime = createRuntime();
    const handle = runtime.client.node(Resource, {});
    try {
      expect(await handle.actions.act()).toMatchObject({ _tag: "Success", value: "first" });
      expect(handle.read()._tag).toBe("Ready");
    } finally {
      await runtime.submit({ _tag: "RuntimeStop" });
    }
  });
});
