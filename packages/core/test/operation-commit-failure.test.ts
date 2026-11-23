import { afterEach, expect, test } from "bun:test";
import * as Frond from "../src";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

async function fixture<Result>(initial: Result, cleanup: () => void) {
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Result;
    readonly actions: {
      readonly replace: Frond.ActionContract<Result>;
      readonly patch: Frond.ActionContract<(current: Result) => void>;
    };
  }>;
  class CommitFailureNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/operation-commit-failure"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => initial),
      actions: {
        replace: Frond.Driver.Action((context, value) => {
          context.disposers.add(cleanup);
          context.setResult(value);
        }),
        patch: Frond.Driver.Action((context, recipe) => {
          context.disposers.add(cleanup);
          context.patchResult(recipe);
        }),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(CommitFailureNode, {});
  const handle = harness.node(CommitFailureNode, {});
  return { harness, node, handle, plain: () => harness.readReady(handle).result };
}

function throwingValue(): { value: number } {
  return new Proxy(
    { value: 9 },
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === "value") throw new Error("poison descriptor");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }
  );
}

test("a failed result commit keeps the action's cleanup for teardown", async () => {
  let disposed = 0;
  const subject = await fixture({ value: 0 }, () => {
    disposed++;
  });
  const before = subject.plain();
  expect(await subject.handle.actions.replace(throwingValue())).toMatchObject({
    _tag: "Failure",
  });
  expect(subject.plain()).toBe(before);
  expect(subject.node.result.value).toBe(0);
  expect(disposed).toBe(0);
  await harnesses.splice(0)[0]?.teardown();
  expect(disposed).toBe(1);
});
