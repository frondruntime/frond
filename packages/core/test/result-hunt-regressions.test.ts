import { afterEach, expect, test } from "bun:test";
import { autorun, isObservable, observable } from "mobx";
import * as Frond from "../src";
import type { ResultPatchOptions } from "../src/driver/types";
import { plainDataEqual } from "../src/graph/resultValidity/plainDataEqual";
import { prepareCommittedResult } from "../src/node/committedResult";
import { isFullyFrozen } from "../src/node/resultData";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const harness of harnesses.splice(0)) await harness.teardown();
});
function disposeAfter(dispose: () => void): void {
  disposers.push(dispose);
}

type Step<Result> =
  | { kind: "patch"; recipe: (current: Result, live: Result) => void }
  | { kind: "update"; recipe: (current: Result) => Result }
  | { kind: "replace"; value: Result }
  | { kind: "throw" }
  | { kind: "gate"; entered: () => void; wait: Promise<void> };

async function fixture<Result>(initial: Result, resultPatch?: ResultPatchOptions) {
  let refreshValue = initial;
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Result;
    readonly actions: { readonly run: Frond.ActionContract<ReadonlyArray<Step<Result>>> };
  }>;
  class HuntNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/result-hunt-regressions"),
      key: () => Frond.Key.singleton(),
      resultPatch,
      acquire: Frond.Driver.Acquire(() => initial),
      refresh: Frond.Driver.Refresh((context) => context.setResult(refreshValue)),
      actions: {
        run: Frond.Driver.Action(async (context, steps) => {
          for (const step of steps) {
            switch (step.kind) {
              case "patch":
                context.patchResult((current) => step.recipe(current, context.node.result));
                break;
              case "update":
                context.setResult(step.recipe);
                break;
              case "replace":
                context.setResult(step.value);
                break;
              case "throw":
                throw new Error("deliberate driver failure");
              case "gate":
                step.entered();
                await step.wait;
                break;
            }
          }
        }),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(HuntNode, {});
  const handle = harness.node(HuntNode, {});
  return {
    harness,
    node,
    plain: () => harness.readReady(handle).result,
    run: (steps: ReadonlyArray<Step<Result>>) => handle.actions.run(steps),
    refresh: (value: Result) => {
      refreshValue = value;
      return handle.refresh();
    },
  };
}

test("C1 replacement then patch and two patches then updater preserve all staged writes", async () => {
  const subject = await fixture({ left: { value: 0 }, right: { value: 1 } });
  expect(
    await subject.run([
      { kind: "replace", value: { left: { value: 10 }, right: { value: 11 } } },
      {
        kind: "patch",
        recipe: (current) => {
          current.left.value++;
        },
      },
      {
        kind: "patch",
        recipe: (current) => {
          current.right.value++;
        },
      },
      {
        kind: "update",
        recipe: (current) => ({ ...current, left: { value: current.left.value + 1 } }),
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(subject.plain()).toEqual({ left: { value: 12 }, right: { value: 12 } });
  expect(subject.node.result).toEqual(subject.plain());
  expect(subject.node.result).toBe(subject.plain());
});

test("C2 snapshot assignment then mutation isolates the source and independent aliases", async () => {
  const shared = { value: 1 };
  const source = await fixture({ left: shared, right: shared });
  const target = await fixture({ left: { value: 0 }, right: { value: 0 } });
  expect(
    await target.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.left = source.node.result.left;
          current.left.value = 9;
          current.right = source.node.result.right;
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(target.plain()).toEqual({ left: { value: 9 }, right: { value: 1 } });
  expect(source.plain().left.value).toBe(1);
  expect(isObservable(target.plain().right)).toBe(false);
  expect(
    await source.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.left.value = 2;
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(source.node.result.right.value).toBe(1);
  expect(target.node.result.right.value).toBe(1);
});

test("C3 length shrink then grow clears removed values in committed data", async () => {
  const subject = await fixture({ rows: [{ value: 1 }, { value: 2 }] });
  let runs = 0;
  disposeAfter(
    autorun(() => {
      subject.node.result.rows[0]?.value;
      runs++;
    })
  );
  expect(
    await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.rows.length = 0;
          current.rows.length = 2;
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(runs).toBe(2);
  const firstLive = Array.from(subject.node.result.rows, (row) => row?.value);
  expect(0 in subject.plain().rows).toBe(false);
  expect(subject.node.result.rows).toBe(subject.plain().rows);
  expect(await subject.refresh({ rows: new Array(2) })).toMatchObject({ _tag: "Success" });
  const equalRefreshLive = Array.from(subject.node.result.rows, (row) => row?.value);
  expect(
    await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.rows[0] = { value: 8 };
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(firstLive).toEqual([undefined, undefined]);
  expect(equalRefreshLive).toEqual([undefined, undefined]);
  expect(Array.from(subject.node.result.rows, (row) => row?.value)).toEqual([8, undefined]);
});

test("C4 removed child draft cannot resurrect a truncated array index", async () => {
  const subject = await fixture({ rows: [{ value: 1 }, { value: 2 }] });
  expect(
    await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          const detached = current.rows[1];
          if (detached === undefined) throw new Error("missing fixture row");
          current.rows.length = 1;
          detached.value = 99;
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(subject.plain().rows).toEqual([{ value: 1 }]);
  expect(subject.node.result.rows.length).toBe(1);
});

test("C5 sparse growth after separate shrink stays synchronized", async () => {
  const subject = await fixture({ rows: [1, 2] });
  expect(
    await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.rows.length = 0;
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(
    await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.rows.length = 2;
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(Array.from(subject.node.result.rows)).toEqual([undefined, undefined]);
  expect(0 in subject.plain().rows).toBe(false);
  expect(
    await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.rows[1] = 7;
        },
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(Array.from(subject.node.result.rows)).toEqual([undefined, 7]);
});

test("C6 refresh queues behind staged action and the next patch uses refreshed state", async () => {
  const subject = await fixture({ value: 1 });
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const action = subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        current.value = 2;
      },
    },
    { kind: "gate", entered: () => entered.resolve(), wait: gate.promise },
  ]);
  await entered.promise;
  const refreshed = subject.refresh({ value: 3 });
  expect(subject.plain().value).toBe(1);
  gate.resolve();
  expect(await action).toMatchObject({ _tag: "Success" });
  expect(await refreshed).toMatchObject({ _tag: "Success" });
  expect(subject.node.result.value).toBe(3);
  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        current.value++;
      },
    },
  ]);
  expect(subject.plain().value).toBe(4);
});

for (const entry of ["replace", "refresh"] as const) {
  test(`F2 throwing proxy during ${entry} commit preserves prior committed snapshot`, async () => {
    const subject = await fixture({ first: { value: 1 }, last: { value: 1 } });
    const before = subject.plain();
    const live = subject.node.result;
    const first = live.first;
    let runs = 0;
    disposeAfter(
      autorun(() => {
        subject.node.result.first.value;
        runs++;
      })
    );
    const poison = new Proxy(
      { value: 9 },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "value") throw new Error("poison descriptor");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );
    const candidate = { first: { value: 8 }, last: poison };
    const outcome =
      entry === "refresh"
        ? await subject.refresh(candidate)
        : await subject.run([{ kind: "replace", value: candidate }]);
    expect(outcome._tag).toBe("Failure");
    expect(subject.node.result).toBe(live);
    expect(live.first).toBe(first);
    expect(runs).toBe(1);
    expect(subject.plain()).toBe(before);
    expect(subject.node.result.first.value).toBe(1);
    expect(subject.node.result).toBe(before);
    expect(first).toBe(before.first);
    const next = await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.first.value++;
        },
      },
    ]);
    expect(next._tag).toBe("Success");
    expect(subject.node.result.first.value).toBe(2);
    expect(subject.plain().first.value).toBe(2);
    expect(subject.plain().last).toBe(before.last);
    expect(subject.node.result).toBe(subject.plain());
  });
}

test("U2 unsafeUpdate after sharing then ordinary patch preserves both writes", async () => {
  const subject = await fixture({ left: { value: 1 }, right: { value: 2 } });
  await subject.refresh({ left: { value: 1 }, right: { value: 3 } });
  const update = await subject.harness.runtime.submit({
    _tag: "GraphUnsafeUpdateNode",
    request: {
      nodeId: subject.node.nodeId,
      recipe: (node) => {
        const typed = node as typeof subject.node;
        typed.result.left.value = 10;
      },
    },
  });
  expect(update).toMatchObject({
    _tag: "GraphUnsafeNodeUpdateCompleted",
    result: { _tag: "Success" },
  });
  expect(subject.plain().left.value).toBe(10);
  expect(isObservable(subject.plain())).toBe(false);
  expect(Object.isFrozen(subject.plain().left)).toBe(true);
  expect(subject.node.result).toBe(subject.plain());
  expect(subject.node.result.left).toBe(subject.plain().left);
  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        current.right.value++;
      },
    },
  ]);
  expect(subject.plain().left.value).toBe(10);
  expect(subject.node.result.left.value).toBe(10);
  expect(subject.plain().right.value).toBe(4);
});

// A draft copy of frozen data skips descriptor validation at freeze, which holds
// only while no accessor can reach the copy through the draft.
test("an accessor defined through a draft never reaches the committed copy", async () => {
  const subject = await fixture({ rows: [1, 2, 3] });
  let reads = 0;
  const outcome = await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        current.rows[1] = 5;
        try {
          Object.defineProperty(current.rows, "0", {
            get: () => {
              reads += 1;
              return 9;
            },
            enumerable: true,
            configurable: true,
          });
        } catch {}
      },
    },
  ]);
  expect(outcome._tag).toBe("Success");
  const committed = subject.plain().rows;
  expect("value" in (Object.getOwnPropertyDescriptor(committed, "0") ?? {})).toBe(true);
  expect(committed).toEqual([1, 5, 3]);
  expect(Array.from(subject.node.result.rows)).toEqual([1, 5, 3]);
  expect(reads).toBe(0);
});

test("draft writes that reach a marked copy keep the committed snapshot consistent", async () => {
  const marker = Symbol.for("result-hunt-marker");
  const subject = await fixture<{ obj: Record<PropertyKey, number> }>({ obj: { a: 1, b: 2 } });
  let reads = 0;
  const outcome = await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        Object.defineProperty(current.obj, "a", {
          get: () => {
            reads += 1;
            return 9;
          },
          enumerable: true,
          configurable: true,
        });
        current.obj.b = 6;
        current.obj[marker] = 7;
      },
    },
  ]);
  expect(outcome._tag).toBe("Success");
  const committed = subject.plain().obj;
  expect(Object.getOwnPropertyDescriptor(committed, "a")).toMatchObject({ value: 1 });
  expect(committed).toEqual({ a: 1, b: 6, [marker]: 7 });
  expect(isFullyFrozen(committed)).toBe(true);
  expect({ ...subject.node.result.obj }).toEqual({ a: 1, b: 6, [marker]: 7 });
  expect(reads).toBe(0);
});

for (const entry of ["patch", "update"] as const) {
  test(`F2 throwing proxy during ${entry} leaves the committed snapshot as before`, async () => {
    const subject = await fixture<{ first: { value: number }; last: { value: number } }>({
      first: { value: 1 },
      last: { value: 1 },
    });
    const before = subject.plain();
    const live = subject.node.result;
    const first = live.first;
    const poison = new Proxy(
      { value: 9 },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "value") throw new Error("poison descriptor");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );
    const outcome = await subject.run([
      entry === "patch"
        ? {
            kind: "patch",
            recipe: (current) => {
              current.first.value = 8;
              current.last = poison;
            },
          }
        : { kind: "update", recipe: () => ({ first: { value: 8 }, last: poison }) },
    ]);
    expect(outcome._tag).toBe("Failure");
    expect(subject.plain()).toBe(before);
    expect(subject.node.result).toBe(live);
    expect(live.first).toBe(first);
    expect(first.value).toBe(1);
    expect(live).toBe(before);
    const next = await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.first.value++;
        },
      },
    ]);
    expect(next._tag).toBe("Success");
    expect(subject.plain().first.value).toBe(2);
    expect(subject.node.result.first.value).toBe(2);
  });
}

test("V9 candidate accessor array cannot receive frozen-source trust", async () => {
  let changing = 1;
  const rows: number[] = [];
  Object.defineProperty(rows, "0", { get: () => changing, enumerable: true, configurable: true });
  const subject = await fixture({ rows });
  expect(Object.isFrozen(rows)).toBe(false);
  expect(isFullyFrozen(rows)).toBe(false);
  expect(subject.node.result.rows).toBe(rows);
  changing = 2;
  expect(await subject.refresh({ rows })).toMatchObject({ _tag: "Success" });
  const refreshedValue = subject.node.result.rows[0];
  changing = 3;
  await subject.run([{ kind: "replace", value: { rows } }]);
  expect(refreshedValue).toBe(2);
  expect(subject.node.result.rows[0]).toBe(3);
});

test("V1 signed zero, NaN, absence and same-value writes across patches and refresh", async () => {
  const subject = await fixture<{ value: number; optional?: undefined }>({ value: -0 });
  let runs = 0;
  disposeAfter(
    autorun(() => {
      subject.node.result.value;
      runs++;
    })
  );
  const original = subject.plain();
  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        current.value = -0;
      },
    },
  ]);
  expect(subject.plain()).toBe(original);
  expect(runs).toBe(1);
  await subject.refresh({ value: 0 });
  expect(Object.is(subject.node.result.value, 0)).toBe(true);
  expect(runs).toBe(2);
  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        current.value = Number.NaN;
        current.optional = undefined;
      },
    },
  ]);
  expect(Object.prototype.hasOwnProperty.call(subject.plain(), "optional")).toBe(true);
  const nan = subject.plain();
  await subject.refresh({ value: Number.NaN, optional: undefined });
  expect(subject.plain()).toBe(nan);
  expect(runs).toBe(3);
  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        delete current.optional;
      },
    },
  ]);
  expect(Object.prototype.hasOwnProperty.call(subject.node.result, "optional")).toBe(false);
  expect(runs).toBe(4);
});

test("V6 equality never invokes throwing accessors and treats hostile proxies as unequal", () => {
  let gets = 0;
  const accessor = () =>
    Object.defineProperty({}, "value", {
      get() {
        gets++;
        throw new Error("getter");
      },
      enumerable: true,
    });
  expect(plainDataEqual(accessor(), accessor())).toBe(false);
  expect(gets).toBe(0);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("keys");
      },
    }
  );
  expect(plainDataEqual(proxy, {})).toBe(false);
  expect(plainDataEqual({}, proxy)).toBe(false);
  expect(plainDataEqual({ value: 1 }, { value: 1 })).toBe(true);
});

class Counter {
  value = 1;
}
for (const policy of ["absent", "share", "clone"] as const) {
  test(`V7 ${policy} non-plain policy is lazy and has declared rollback behavior`, async () => {
    const counter = new Counter();
    const options =
      policy === "absent"
        ? undefined
        : policy === "share"
          ? { nonPlainClone: "share" as const }
          : {
              nonPlainClone: (value: object) => Object.assign(new Counter(), value),
            };
    const subject = await fixture({ counter, revision: 0 }, options);
    await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.revision++;
        },
      },
    ]);
    expect(subject.node.result.revision).toBe(1);
    const outcome = await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.counter.value++;
        },
      },
      { kind: "throw" },
    ]);
    expect(outcome).toMatchObject({ _tag: "Failure" });
    expect(counter.value).toBe(policy === "share" ? 2 : 1);
    expect(subject.node.result.counter.value).toBe(policy === "share" ? 2 : 1);
    const next = await subject.run([
      {
        kind: "patch",
        recipe: (current) => {
          current.counter.value++;
        },
      },
    ]);
    expect(next._tag).toBe(policy === "absent" ? "Failure" : "Success");
    expect(subject.node.result.counter.value).toBe(
      policy === "absent" ? 1 : policy === "share" ? 3 : 2
    );
  });
}

test("V10 array sharing preserves holes versus present undefined in committed data", () => {
  const before = prepareCommittedResult({ rows: new Array(2) }, undefined, false, true) as {
    rows: unknown[];
  };
  const after = prepareCommittedResult({ rows: [undefined, undefined] }, before, true, true) as {
    rows: unknown[];
  };
  expect(after).not.toBe(before);
  expect(0 in before.rows).toBe(false);
  expect(0 in after.rows).toBe(true);
});

test("an array result keeps its envelope on both result surfaces through every write", async () => {
  const internal = { resource: "owned" };
  const subject = await fixture(Frond.withInternal([{ value: 0 }], internal));
  const both = () => [Frond.internalOf(subject.plain()), Frond.internalOf(subject.node.result)];
  expect(both()).toEqual([internal, internal]);

  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        current.push({ value: 1 });
      },
    },
  ]);
  expect(both()).toEqual([internal, internal]);
  expect(subject.node.result.map((row) => row.value)).toEqual([0, 1]);

  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        for (const row of current.slice(0, 1)) row.value = 5;
      },
    },
  ]);
  expect(both()).toEqual([internal, internal]);

  await subject.run([
    { kind: "update", recipe: (current) => Frond.carryInternal(current, [...current]) },
  ]);
  expect(both()).toEqual([internal, internal]);

  const next = { resource: "refreshed" };
  await subject.refresh(Frond.withInternal([{ value: 7 }], next));
  expect(both()).toEqual([next, next]);
  expect(subject.node.result.map((row) => row.value)).toEqual([7]);

  const update = await subject.harness.runtime.submit({
    _tag: "GraphUnsafeUpdateNode",
    request: {
      nodeId: subject.node.nodeId,
      recipe: (node) => {
        for (const row of (node as typeof subject.node).result.slice(0, 1)) row.value = 8;
      },
    },
  });
  expect(update).toMatchObject({ result: { _tag: "Success" } });
  expect(both()).toEqual([next, next]);
  expect(subject.plain()[0]?.value).toBe(8);
});

for (const nested of [false, true]) {
  test(`a shared observable array notifies only its content readers (nested=${nested})`, async () => {
    const rows = observable.array([1]);
    const initial = nested ? { rows } : rows;
    const subject = await fixture(initial, { nonPlainClone: "share" });
    let runs = 0;
    const lengths: number[] = [];
    disposeAfter(
      autorun(() => {
        void subject.node.result;
        runs++;
      })
    );
    disposeAfter(
      autorun(() => {
        const current = subject.node.result;
        lengths.push((Array.isArray(current) ? current : current.rows).length);
      })
    );
    expect(
      await subject.run([
        {
          kind: "patch",
          recipe: (current) => {
            (Array.isArray(current) ? current : current.rows).push(2);
          },
        },
      ])
    ).toMatchObject({ _tag: "Success" });
    expect(subject.node.result).toBe(initial);
    expect(subject.plain()).toBe(initial);
    expect(rows.slice()).toEqual([1, 2]);
    expect(runs).toBe(1);
    expect(lengths).toEqual([1, 2]);
  });
}

test("a no-op patch of cyclic plain data does not notify result readers", async () => {
  const initial: { value: number; self?: unknown } = { value: 1 };
  initial.self = initial;
  const subject = await fixture(initial);
  let runs = 0;
  disposeAfter(
    autorun(() => {
      void subject.node.result;
      runs++;
    })
  );
  expect(await subject.run([{ kind: "patch", recipe: () => {} }])).toMatchObject({
    _tag: "Success",
  });
  expect(subject.node.result).toBe(initial);
  expect(runs).toBe(1);
});

test("removing the last shared model makes subsequent plain no-op patches silent", async () => {
  const subject = await fixture<{ value: number; counter?: Counter }>(
    { value: 1, counter: new Counter() },
    { nonPlainClone: "share" }
  );
  let runs = 0;
  disposeAfter(
    autorun(() => {
      void subject.node.result;
      runs++;
    })
  );
  await subject.run([
    {
      kind: "patch",
      recipe: (current) => {
        delete current.counter;
      },
    },
  ]);
  expect(runs).toBe(2);
  await subject.run([{ kind: "patch", recipe: () => {} }]);
  expect(runs).toBe(2);
});
