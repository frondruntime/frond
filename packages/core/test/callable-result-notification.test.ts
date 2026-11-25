import { afterEach, expect, test } from "bun:test";
import { autorun } from "mobx";
import * as Frond from "../src";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

type Counter = (() => void) & { count: number };
type Shape = "root" | "child" | "symbol";
const slot = Symbol("counter");

function build(shape: Shape) {
  const counter: Counter = Object.assign(() => {}, { count: 0 });
  return shape === "root" ? counter : shape === "child" ? { counter } : { [slot]: counter };
}
function counterOf(result: unknown): Counter {
  if (typeof result === "function") return result as Counter;
  const record = result as { counter?: Counter; [slot]?: Counter };
  return (record.counter ?? record[slot]) as Counter;
}

async function start(shape: Shape) {
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: unknown;
    readonly actions: { readonly bump: Frond.ActionContract<void> };
  }>;
  class CallableNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag(`test/callable-result-notification/${shape}`),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => build(shape)),
      actions: {
        bump: Frond.Driver.Action(async (context) => {
          context.patchResult((current) => {
            counterOf(current).count += 1;
          });
        }),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(CallableNode, {});
  const handle = harness.node(CallableNode, {});
  return { node, bump: () => handle.actions.bump() };
}

for (const shape of ["root", "child", "symbol"] as const) {
  test(`patching a callable ${shape} result notifies readers`, async () => {
    const subject = await start(shape);
    const seen: Array<number> = [];
    disposers.push(autorun(() => seen.push(counterOf(subject.node.result).count)));
    await subject.bump();
    expect(seen).toEqual([0, 1]);
  });
}
