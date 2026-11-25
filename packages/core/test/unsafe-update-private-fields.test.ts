import { afterEach, expect, test } from "bun:test";
import * as Frond from "../src";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

type CounterSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly result: { readonly count: number };
}>;

class CounterNode extends Frond.NodeBase<CounterSpec> {
  static readonly spec = Frond.serviceSpec.async<CounterSpec>({
    tag: Frond.tag("test/unsafe-update-private-fields"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(() => ({ count: 1 })),
  });

  readonly #step = 10;

  get nextCount(): number {
    return this.result.count + this.#step;
  }

  bump(): void {
    (this.result as { count: number }).count += this.#step;
  }
}

async function start() {
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(CounterNode, {});
  const handle = harness.node(CounterNode, {});
  const update = (recipe: (node: CounterNode) => void) =>
    harness.runtime.submit({
      _tag: "GraphUnsafeUpdateNode",
      request: { nodeId: node.nodeId, recipe: (target) => recipe(target as CounterNode) },
    });
  return { update, read: () => harness.readReady(handle).result };
}

test("an unsafe update recipe reads a getter that uses a private field", async () => {
  const subject = await start();
  const update = await subject.update((node) => {
    const next = node.nextCount;
    (node.result as { count: number }).count = next;
  });
  expect(update).toMatchObject({ result: { _tag: "Success" } });
  expect(subject.read().count).toBe(11);
});

test("an unsafe update recipe calls a method that uses a private field and writes the draft", async () => {
  const subject = await start();
  const update = await subject.update((node) => {
    node.bump();
    expect(node.result.count).toBe(11);
  });
  expect(update).toMatchObject({ result: { _tag: "Success" } });
  expect(subject.read().count).toBe(11);
  expect(Object.isFrozen(subject.read())).toBe(true);
});
