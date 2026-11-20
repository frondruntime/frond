import { expect, test } from "bun:test";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  MobX,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "../src";

test("MobX result mirrors a committed change from positive to negative zero", async () => {
  type Spec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: number;
    readonly actions: { readonly negate: ActionContract<void, void> };
  }>;
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "test/mobx-signed-zero",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => 0),
      actions: { negate: Driver.Action((ctx) => ctx.setResult(-0)) },
    });
  }
  const runtime = createRuntime();
  const projection = MobX.createNode(runtime, Resource, {});
  try {
    await projection.ensureReady();
    expect(Object.is(projection.result, 0)).toBe(true);
    await projection.runAction("negate");
    expect(Object.is(projection.node.result, -0)).toBe(true);
    expect(Object.is(projection.result, -0)).toBe(true);
  } finally {
    projection.dispose();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
