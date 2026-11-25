import { describe, expect, test } from "bun:test";
import { reaction } from "mobx";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "../src/index";

type Data = {
  readonly list: readonly { readonly value: number }[];
  readonly extra: Record<string, unknown>;
};
type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Data;
  readonly actions: { readonly touch: ActionContract<void, void> };
}>;

describe("direct driver edges", () => {
  test("a throwing promise then getter reports a driver failure and releases the cell", async () => {
    const cause = new Error("then getter failed");
    let fail = true;
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "edges/throwing-then",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => ({ list: [], extra: {} })),
        actions: {
          touch: Driver.Action(() => {
            if (!fail) return;
            const promise = Promise.resolve();
            // biome-ignore lint/suspicious/noThenProperty: exercise a malformed driver promise at the public boundary.
            Object.defineProperty(promise, "then", {
              get: () => {
                throw cause;
              },
            });
            return promise;
          }),
        },
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(Resource, {});
    expect(await handle.actions.touch()).toMatchObject({
      _tag: "Failure",
      error: { _tag: "ActionFailed", cause: { _tag: "DriverPromiseFailed", cause } },
    });
    fail = false;
    expect(await handle.actions.touch()).toMatchObject({ _tag: "Success" });
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("equal refresh retains the result and emits no MobX result change; a different refresh replaces it", async () => {
    let value = 1;
    const data = (): Data => ({
      list: [{ value }],
      extra: Object.assign(Object.create(null), { missing: undefined, nan: Number.NaN }),
    });
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "edges/equal-refresh",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(data),
        refresh: Driver.Refresh((ctx) => ctx.setResult(data())),
        actions: { touch: Driver.Action((ctx) => ctx.patchResult(() => undefined)) },
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(Resource, {});
    const node = await handle.ensureReadyNode();
    const original = node.result;
    const changes: unknown[] = [];
    const dispose = reaction(
      () => node.result,
      (result) => changes.push(result)
    );
    await handle.refresh();
    expect(node.result).toBe(original);
    expect(changes).toHaveLength(0);
    value = 2;
    await handle.refresh();
    expect(node.result).not.toBe(original);
    expect(node.result.list[0]?.value).toBe(2);
    expect(changes).toHaveLength(1);
    const refreshed = node.result;
    await handle.actions.touch();
    expect(node.result).toBe(refreshed);
    expect(changes).toHaveLength(1);
    dispose();
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("expiry re-acquire retains equal plain results and stamps all core time with syncClock", async () => {
    let now = 100;
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "edges/equal-reacquire",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        resultValidity: { _tag: "TimeBound", expireAfter: 10 },
        acquire: Driver.Acquire(() => ({ list: [{ value: 1 }], extra: {} })),
        actions: { touch: Driver.Action(() => undefined) },
      });
    }
    const runtime = createRuntime({
      development: true,
      eventBufferSize: 512,
      syncClock: { now: () => now },
    });
    const handle = runtime.client.node(Resource, {});
    const committed = () => {
      const read = handle.read();
      return read._tag === "Ready" ? read.result : undefined;
    };
    const first = await handle.ensureReadyNode();
    const result = committed();
    now = 200;
    const second = await handle.ensureReadyNode();
    expect(second).not.toBe(first);
    expect(committed()).toBe(result);
    expect(second.result).toEqual(result);
    await handle.actions.touch();
    const events = await runtime.query({ _tag: "RuntimeEvents" });
    expect(events.events.every((record) => record.recordedAt === record.event.at)).toBe(true);
    expect(
      events.events.every((record) => record.recordedAt === 100 || record.recordedAt === 200)
    ).toBe(true);
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("plain equality never replaces Date identity semantics", async () => {
    type DateSpec = NodeSpec<{
      readonly mode: "async";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly date: Date };
    }>;
    class Resource extends NodeBase<DateSpec> {
      static readonly spec = serviceSpec.async<DateSpec>({
        tag: "edges/date-refresh",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => ({ date: new Date(0) })),
        refresh: Driver.Refresh((ctx) => ctx.setResult({ date: new Date(0) })),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(Resource, {});
    const node = await handle.ensureReadyNode();
    const date = node.result.date;
    await handle.refresh();
    expect(node.result.date).not.toBe(date);
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("sync hooks run after submission and publish committed result before the caller resumes", async () => {
    let calls = 0;
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "edges/sync-order",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => ({ list: [{ value: 0 }], extra: {} })),
        actions: {
          touch: Driver.Action((ctx) => {
            calls += 1;
            ctx.setResult({ list: [{ value: calls }], extra: {} });
          }),
        },
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(Resource, {});
    const node = await handle.ensureReadyNode();
    const order: string[] = [];
    const dispose = reaction(
      () => node.result,
      () => order.push("mobx")
    );
    const action = handle.actions.touch();
    expect(calls).toBe(0);
    await action;
    order.push("caller");
    expect(node.result.list[0]?.value).toBe(1);
    expect(order).toEqual(["mobx", "caller"]);
    dispose();
    await runtime.submit({ _tag: "RuntimeStop" });
  });
});
