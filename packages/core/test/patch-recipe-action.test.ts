// A patch recipe runs inside a MobX action, so mutating a shared observable
// result does not trip MobX strict mode.
import { expect, spyOn, test } from "bun:test";
import { autorun, makeAutoObservable } from "mobx";
import { createRuntime, Driver, Key } from "../src";
import {
  type ActionContract,
  dependencies,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "../src/node";

class Pair {
  a = 0;
  constructor() {
    makeAutoObservable(this);
  }
}

type PairSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Pair;
  readonly actions: { readonly patchA: ActionContract };
}>;

class PairNode extends NodeBase<PairSpec> {
  static readonly spec = resourceSpec.async<PairSpec>({
    tag: "test/patch-recipe-action/pair",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultPatch: { nonPlainClone: "share" },
    acquire: Driver.Acquire(() => new Pair()),
    actions: {
      patchA: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.a += 1;
        });
      }),
    },
  });
}

test("a patch recipe on an observed shared result runs inside a MobX action", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const warn = spyOn(console, "warn");
  try {
    const handle = runtime.client.node(PairNode, {});
    const node = await handle.ensureReadyNode();
    const seen: number[] = [];
    const dispose = autorun(() => {
      seen.push(node.result.a);
    });
    expect((await handle.actions.patchA())._tag).toBe("Success");
    dispose();
    // The field notifies during staging without a duplicate notification at commit.
    expect(seen).toEqual([0, 1]);
    const mobxWarnings = warn.mock.calls.filter((call) => String(call[0]).includes("[MobX]"));
    expect(mobxWarnings).toEqual([]);
  } finally {
    warn.mockRestore();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
