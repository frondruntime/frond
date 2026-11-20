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

test("patchResult preserves an own __proto__ data property from JSON", async () => {
  type Payload = { count: number; readonly __proto__: { readonly label: string } };
  type Spec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: Payload;
    readonly actions: { readonly increment: ActionContract<void, void> };
  }>;
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "test/patch-clone-proto-key",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(
        (): Payload => JSON.parse('{"count":0,"__proto__":{"label":"data"}}')
      ),
      actions: {
        increment: Driver.Action((ctx) =>
          ctx.patchResult((draft) => {
            draft.count += 1;
          })
        ),
      },
    });
  }
  const runtime = createRuntime();
  try {
    const node = await runtime.client.node(Resource, {}).ensureReadyNode();
    await node.actions.increment();
    expect(node.result.count).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(node.result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(node.result)).toBe(Object.prototype);
    expect(JSON.stringify(node.result)).toBe('{"count":1,"__proto__":{"label":"data"}}');
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
