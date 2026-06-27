import { describe, expect, test } from "bun:test";
import type {
  ActionContract,
  AsyncDriverContext,
  NodeSpecArgs,
  NodeSpecResolvedDeps,
} from "../src";
import {
  Args,
  createRuntime,
  Driver,
  FrondNodeConstructionUnavailable,
  Key,
  NodeBase,
  resourceSpec,
  tag,
} from "../src";

type StaticCounterSpec = import("../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly count: number };
  readonly actions: {
    readonly add: ActionContract<{ readonly by: number }, number>;
  };
}>;

class StaticCounterNode extends NodeBase<StaticCounterSpec> {
  static readonly spec = resourceSpec<StaticCounterSpec>({
    tag: tag("tests/static-counter"),
    key: () => Key.singleton(),
    driver: Driver.Async<StaticCounterSpec>({
      acquire: Driver.Acquire(() => ({ count: 1 })),
      actions: {
        add: Driver.Action(
          (
            ctx: AsyncDriverContext<
              NodeBase<StaticCounterSpec>,
              NodeSpecArgs<StaticCounterSpec>,
              NodeSpecResolvedDeps<StaticCounterSpec>,
              { readonly count: number }
            >,
            input: { readonly by: number }
          ) => ctx.node.result.count + input.by
        ),
      },
    }),
  });

  get count(): number {
    return this.result.count;
  }
}

type AdmissionSpec = import("../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: string;
  readonly actions: {
    readonly rejectSlow: ActionContract<{ readonly id: string }, string>;
    readonly joinSlow: ActionContract<{ readonly id: string }, string>;
  };
}>;

describe("static-spec authoring", () => {
  test("graph planning accepts node specs and instantiates the exported class", async () => {
    const runtime = createRuntime();
    const ready = await runtime.client.node(StaticCounterNode, Args.none).ensureReady();
    const node = ready.node;

    expect(node).toBeInstanceOf(StaticCounterNode);
    expect(node.count).toBe(1);
    await expect(node.actions.add({ by: 2 })).resolves.toBe(3);
    expect(() => new StaticCounterNode()).toThrow(FrondNodeConstructionUnavailable);
  });

  test("graph planning rejects NodeBase subclasses that are not node specs", async () => {
    class MissingSpecNode extends NodeBase<StaticCounterSpec> {}

    const runtime = createRuntime();
    expect(() =>
      runtime.client.node(MissingSpecNode as typeof StaticCounterNode, Args.none)
    ).toThrow("static spec");
  });

  test("graph planning rejects direct descriptor objects", () => {
    const runtime = createRuntime();
    const descriptor = (StaticCounterNode.spec as unknown as { readonly spec: unknown }).spec;

    expect(() =>
      runtime.client.node(descriptor as unknown as typeof StaticCounterNode, Args.none)
    ).toThrow("static spec");
  });

  test("action admission rejects concurrent requests when policy is reject", async () => {
    const gate = makeGate();

    class AdmissionNode extends NodeBase<AdmissionSpec> {
      static readonly spec = resourceSpec<AdmissionSpec>({
        tag: tag("tests/action-admission-reject"),
        key: () => Key.singleton(),
        driver: Driver.Async<AdmissionSpec>({
          acquire: Driver.Acquire(() => "ready"),
          actions: {
            rejectSlow: Driver.Action(
              async (_ctx, input: { readonly id: string }) => {
                gate.markStarted();
                await gate.promise;
                return input.id;
              },
              { admission: "reject" }
            ),
            joinSlow: Driver.Action((_ctx, input: { readonly id: string }) => input.id, {
              admission: "join",
              admissionKey: (input) => input.id,
            }),
          },
        }),
      });
    }

    const runtime = createRuntime();
    const ready = await runtime.client.node(AdmissionNode, Args.none).ensureReady();
    const node = ready.node;
    const first = node.actions.rejectSlow({ id: "a" });
    await gate.started;
    const second = node.actions.rejectSlow({ id: "a" });

    await expect(second).rejects.toHaveProperty("_tag", "ActionFailed");
    gate.resolve();
    await expect(first).resolves.toBe("a");
  });

  test("action admission joins concurrent requests with the same admission key", async () => {
    const gate = makeGate();
    let runs = 0;

    class AdmissionNode extends NodeBase<AdmissionSpec> {
      static readonly spec = resourceSpec<AdmissionSpec>({
        tag: tag("tests/action-admission-join"),
        key: () => Key.singleton(),
        driver: Driver.Async<AdmissionSpec>({
          acquire: Driver.Acquire(() => "ready"),
          actions: {
            rejectSlow: Driver.Action((_ctx, input: { readonly id: string }) => input.id),
            joinSlow: Driver.Action(
              async (_ctx, input: { readonly id: string }) => {
                runs += 1;
                gate.markStarted();
                await gate.promise;
                return input.id;
              },
              {
                admission: "join",
                admissionKey: (input) => input.id,
              }
            ),
          },
        }),
      });
    }

    const runtime = createRuntime();
    const ready = await runtime.client.node(AdmissionNode, Args.none).ensureReady();
    const node = ready.node;
    const first = node.actions.joinSlow({ id: "joined" });
    await gate.started;
    const second = node.actions.joinSlow({ id: "joined" });

    gate.resolve();
    await expect(first).resolves.toBe("joined");
    await expect(second).resolves.toBe("joined");
    expect(runs).toBe(1);
  });

  test("Driver.Action rejects malformed join admission descriptors", () => {
    expect(() =>
      Driver.Action((_ctx: unknown, _input: { readonly id: string }) => undefined, {
        admission: "join",
      } as never)
    ).toThrow("admissionKey");
  });
});

function makeGate(): {
  readonly promise: Promise<void>;
  readonly started: Promise<void>;
  readonly markStarted: () => void;
  readonly resolve: () => void;
} {
  let resolveGate: (() => void) | undefined;
  let resolveStarted: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  return {
    promise,
    started,
    markStarted: () => resolveStarted?.(),
    resolve: () => resolveGate?.(),
  };
}
