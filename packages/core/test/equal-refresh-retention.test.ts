// An equal refresh keeps the old result only for plain data; anything the
// comparison cannot vouch for (or that throws while compared) is replaced.
import { expect, test } from "bun:test";
import * as Frond from "../src";

async function refreshed(initial: unknown, replacement: unknown): Promise<unknown> {
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Frond.Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: unknown;
  }>;
  class Resource extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/equal-refresh/cases"),
      key: () => Frond.Key.singleton(),
      dependencies: Frond.dependencies(() => ({})),
      acquire: Frond.Driver.Acquire(() => initial),
      refresh: Frond.Driver.Refresh((ctx) => ctx.setResult(replacement)),
    });
  }
  const runtime = Frond.createRuntime({ development: true, eventBufferSize: 512 });
  try {
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    expect(await handle.refresh()).toMatchObject({ _tag: "Success" });
    // The committed value; `node.result` is the runtime's live mirror of it.
    const read = handle.read();
    return read._tag === "Ready" ? read.result : undefined;
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}

test("array class instances must retain their own private state after refresh", async () => {
  class Rows extends Array<number> {
    #version: number;
    constructor(version: number) {
      super();
      this.push(1);
      this.#version = version;
    }
    get version(): number {
      return this.#version;
    }
  }
  const previous = new Rows(1);
  const next = new Rows(2);
  const result = await refreshed(previous, next);
  expect(result).toBe(next);
  expect((result as Rows).version).toBe(2);
});

test("refresh must not evaluate arbitrary result getters", async () => {
  const result = () => ({
    get unavailable(): never {
      throw new Error("result getter is not data");
    },
  });
  const next = result();
  expect(await refreshed(result(), next)).toBe(next);
});

test("equal getter values must not retain a stale accessor closure", async () => {
  const left = { value: 1 };
  const right = { value: 1 };
  const previous = {
    get value() {
      return left.value;
    },
  };
  const next = {
    get value() {
      return right.value;
    },
  };
  const result = (await refreshed(previous, next)) as { readonly value: number };
  right.value = 2;
  expect(result.value).toBe(2);
});

test("plain-data equality handles cycles, symbols, sparse arrays, extra keys and Object.is", async () => {
  const symbol = Symbol("key");
  const cycleA: { value: number; self?: unknown } = { value: 1 };
  const cycleB: { value: number; self?: unknown } = { value: 1 };
  cycleA.self = cycleA;
  cycleB.self = cycleB;
  const cycleC: { value: number; self?: unknown } = { value: 2 };
  cycleC.self = cycleC;
  const cases: ReadonlyArray<readonly [unknown, unknown, boolean]> = [
    [{ value: Number.NaN }, { value: Number.NaN }, true],
    [{ value: 0 }, { value: -0 }, false],
    [new Array(2), new Array(2), true],
    [new Array(1), [undefined], false],
    [{ [symbol]: 1 }, { [symbol]: 1 }, true],
    [{ [symbol]: 1 }, { [symbol]: 2 }, false],
    [{ a: undefined }, {}, false],
    [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
    [
      Object.assign(Object.create(null), { a: 1 }),
      Object.assign(Object.create(null), { a: 1 }),
      true,
    ],
    [Object.assign([1], { extra: 1 }), Object.assign([1], { extra: 2 }), false],
    [cycleA, cycleB, true],
    [cycleA, cycleC, false],
    [new Map([["a", 1]]), new Map([["a", 1]]), false],
  ];
  for (const [previous, next, equal] of cases) {
    expect(await refreshed(previous, next)).toBe(equal ? previous : next);
  }
});

type Spec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly result: unknown;
}>;

let tagCounter = 0;
function nodeOf(results: () => unknown) {
  tagCounter += 1;
  class Resource extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag(`test/equal-refresh/edge-${tagCounter}`),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => results()),
      refresh: Frond.Driver.Refresh((ctx) => ctx.setResult(results())),
    });
  }
  return Resource;
}

async function refreshTwice(results: () => unknown) {
  const runtime = Frond.createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(nodeOf(results), {});
  await handle.ensureReady();
  const before = handle.readReady().result;
  const refresh = await handle.refresh();
  const after = handle.read();
  await runtime.submit({ _tag: "RuntimeStop" });
  return { before, refresh, after };
}

test("a deeply nested equal result still refreshes (comparison is recursive)", async () => {
  const depth = 200_000;
  const make = () => {
    let value: { next?: unknown } = {};
    for (let i = 0; i < depth; i += 1) value = { next: value };
    return value;
  };
  const { refresh, after } = await refreshTwice(make);
  expect(refresh).toMatchObject({ _tag: "Success" });
  expect(after).toMatchObject({ _tag: "Ready" });
});

test("a throwing accessor on the previous result does not fail the refresh", async () => {
  let generation = 0;
  const make = () => {
    generation += 1;
    const own = generation;
    const result = { id: 1 } as Record<string, unknown>;
    // A lazily computed field whose source is gone once a newer result exists.
    Object.defineProperty(result, "detail", {
      enumerable: true,
      get: () => {
        if (own < generation) throw new Error("stale detail");
        return "detail";
      },
    });
    return result;
  };
  const { refresh } = await refreshTwice(make);
  expect(refresh).toMatchObject({ _tag: "Success" });
});

test("a null-prototype previous result is not kept for an ordinary new result", async () => {
  let first = true;
  const make = () => {
    if (!first) return { a: 1 };
    first = false;
    return Object.assign(Object.create(null), { a: 1 });
  };
  const { after } = await refreshTwice(make);
  if (after._tag !== "Ready") throw new Error("expected Ready");
  expect(Object.getPrototypeOf(after.result)).toBe(Object.prototype);
});

test("a failed expiry re-acquire forgets the previous result", async () => {
  let now = 100;
  let acquires = 0;
  type ExpiringSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Frond.Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: { readonly value: number };
  }>;
  class Resource extends Frond.NodeBase<ExpiringSpec> {
    static readonly spec = Frond.serviceSpec.async<ExpiringSpec>({
      tag: Frond.tag("test/equal-refresh/failed-reacquire"),
      key: () => Frond.Key.singleton(),
      dependencies: Frond.dependencies(() => ({})),
      resultValidity: { _tag: "TimeBound", expireAfter: 10 },
      acquire: Frond.Driver.Acquire(() => {
        acquires += 1;
        if (acquires === 2) throw new Error("re-acquire failed");
        return { value: 1 };
      }),
    });
  }
  const runtime = Frond.createRuntime({
    development: true,
    eventBufferSize: 512,
    syncClock: { now: () => now },
  });
  try {
    const handle = runtime.client.node(Resource, {});
    const first = (await handle.ensureReadyNode()).result;
    now = 200;
    expect(await handle.ensureReady()).toMatchObject({ _tag: "Error" });
    const third = (await handle.ensureReadyNode()).result;
    expect(acquires).toBe(3);
    // The first result belongs to a torn-down incarnation; an equal value
    // from a later acquire must not bring it back.
    expect(third).not.toBe(first);
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
