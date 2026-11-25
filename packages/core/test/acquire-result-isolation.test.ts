import { expect, test } from "bun:test";
import * as Frond from "../src";
import { prepareCommittedResult } from "../src/node/committedResult";
import { containsCommittedPlainData, maxResultDepth } from "../src/node/resultData";
import * as FrondTest from "../src/testing";

test("committed-container detection handles cycles, opaque slots, and the depth limit", () => {
  const committed = { value: 0 };
  prepareCommittedResult(committed, undefined, false, false);
  const cycle: { next?: object; cached?: object } = {};
  cycle.next = cycle;
  expect(containsCommittedPlainData(cycle)).toBe(false);
  cycle.cached = committed;
  expect(containsCommittedPlainData(cycle)).toBe(true);
  class Opaque {
    cached = committed;
  }
  const customArray = Object.assign([], { cached: committed, NaN: committed });
  for (const value of [
    new Opaque(),
    new Map([["cached", committed]]),
    { [Symbol()]: committed },
    customArray,
  ]) {
    expect(containsCommittedPlainData(value)).toBe(false);
  }
  const links: Array<{ next?: object }> = Array.from({ length: maxResultDepth }, () => ({}));
  for (let index = 0; index < links.length; index += 1) {
    const current = links[index];
    if (current !== undefined) current.next = links[index + 1] ?? committed;
  }
  expect(containsCommittedPlainData(links[0])).toBe(false);
  expect(containsCommittedPlainData(links[1])).toBe(true);
  const unread = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("Must stop at the first committed container");
      },
    }
  );
  expect(containsCommittedPlainData({ committed, unread })).toBe(true);
});

test("committed-container detection visits a shared fresh subtree once", () => {
  let enumerations = 0;
  let value: object = {};
  for (let depth = 0; depth < 20; depth += 1) {
    value = new Proxy(
      { left: value, right: value },
      {
        ownKeys(target) {
          enumerations += 1;
          if (enumerations > 20) throw new Error("Repeated fresh subtree traversal");
          return Reflect.ownKeys(target);
        },
      }
    );
  }
  expect(containsCommittedPlainData(value)).toBe(false);
  expect(enumerations).toBe(20);
});

for (const development of [false, true]) {
  for (const method of ["patch", "update"] as const) {
    for (const nested of [false, true]) {
      test(`acquire isolates committed staging: development=${development}/${method}/nested=${nested}`, async () => {
        const cached = { value: 0 };
        type Result = { child: { value: number } };
        type Spec = Frond.NodeSpec<{
          readonly mode: "async";
          readonly key: Frond.Key.Singleton;
          readonly result: Result;
        }>;
        const shared = { child: cached };
        class Owner extends Frond.NodeBase<Spec> {
          static readonly spec = Frond.serviceSpec.async<Spec>({
            tag: Frond.tag("test/acquire-result-isolation/owner"),
            key: () => Frond.Key.singleton(),
            acquire: Frond.Driver.Acquire(() => shared),
          });
        }
        class Borrower extends Frond.NodeBase<Spec> {
          static readonly spec = Frond.serviceSpec.async<Spec>({
            tag: Frond.tag("test/acquire-result-isolation/borrower"),
            key: () => Frond.Key.singleton(),
            acquire: Frond.Driver.Acquire((context) => {
              context.setResult(nested ? { child: cached } : shared);
              if (method === "patch") {
                context.patchResult((current) => {
                  current.child.value = 1;
                });
              } else {
                context.setResult((current) => {
                  current.child.value = 1;
                  return current;
                });
              }
              if (!development) throw new Error("reject acquire");
            }),
          });
        }
        const harness = FrondTest.createFrondTestHarness({ development });
        try {
          const owner = await harness.startNode(Owner, {});
          const before = owner.result;
          const borrower = harness.node(Borrower, {});
          const outcome = await borrower.ensureReady();
          expect(outcome._tag).toBe(development ? "Ready" : "Error");
          expect(owner.result).toBe(before);
          expect(before.child.value).toBe(0);
          if (outcome._tag === "Ready")
            expect(harness.readReady(borrower).result.child.value).toBe(1);
        } finally {
          await harness.teardown();
        }
      });
    }
  }
}

for (const development of [false, true]) {
  test(`fresh acquire staging stays mutable: development=${development}`, async () => {
    const value = { value: 0 };
    type Spec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly key: Frond.Key.Singleton;
      readonly result: { value: number };
    }>;
    class FreshNode extends Frond.NodeBase<Spec> {
      static readonly spec = Frond.serviceSpec.async<Spec>({
        tag: Frond.tag("test/acquire-result-isolation/fresh"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire((context) => {
          context.setResult(value);
          expect(Object.isFrozen(value)).toBe(false);
          context.patchResult((draft) => {
            draft.value = 1;
          });
          return value;
        }),
      });
    }
    const harness = FrondTest.createFrondTestHarness({ development });
    try {
      const node = await harness.startNode(FreshNode, {});
      expect(node.result).toBe(value);
      expect(value.value).toBe(1);
      expect(Object.isFrozen(value)).toBe(development);
    } finally {
      await harness.teardown();
    }
  });
}
