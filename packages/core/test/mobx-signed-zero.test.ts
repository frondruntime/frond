import { expect, test } from "bun:test";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "../src";

test("the class node preserves a committed change from positive to negative zero", async () => {
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
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(Resource, {});
  try {
    const node = await handle.ensureReadyNode();
    expect(Object.is(handle.readReady().result, 0)).toBe(true);
    expect((await handle.actions.negate())._tag).toBe("Success");
    expect(Object.is(node.result, -0)).toBe(true);
    expect(Object.is(handle.readReady().result, -0)).toBe(true);
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
