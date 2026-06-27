import { describe, expect, test } from "bun:test";
import { FrondNodeSpecError } from "../src/node";
import {
  type ActionContract,
  Driver,
  DriverPromiseFailed,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  RefreshFailed,
  resourceSpec,
} from "./graphTestFixtures";

type AsyncAuthoringResult = {
  count: number;
  label: string;
};

describe("driver authoring modes", () => {
  test("node tags fail loudly when malformed values bypass TypeScript", () => {
    expect(() =>
      resourceSpec({
        tag: "drivers/malformed tag" as never,
        key: () => ({}),
        driver: Driver.Async({
          acquire: Driver.Acquire(() => ({ ok: true })),
        }),
      })
    ).toThrow(FrondNodeSpecError);
  });

  test("async driver stages acquire, refresh, action, and release through runtime paths", async () => {
    const released: Array<string> = [];
    type AsyncAuthoringSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: AsyncAuthoringResult;
      readonly actions: {
        readonly increment: ActionContract<{ readonly by: number }, { readonly count: number }>;
      };
    }>;

    class AsyncAuthoringNode extends NodeBase<AsyncAuthoringSpec> {
      static readonly spec = resourceSpec<AsyncAuthoringSpec>({
        tag: "drivers/async-authoring",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Async<AsyncAuthoringSpec>({
          acquire: Driver.Acquire(() => ({ count: 0, label: "initial" })),
          refresh: Driver.Refresh(async (ctx) => {
            ctx.patchResult((current) => {
              current.label = "refreshed";
            });
          }),
          release: Driver.Release(async () => {
            released.push("released");
          }),
          actions: {
            increment: Driver.Action(async (ctx, input) => {
              ctx.patchResult((current) => {
                current.count += input.by;
              });

              return { count: input.by };
            }),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const ready = await Effect.runPromise(
      graph.ensureReadyNode({ spec: AsyncAuthoringNode, args: {} })
    );
    const refresh = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: AsyncAuthoringNode, args: {} },
        },
      })
    );
    const action = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: AsyncAuthoringNode, args: {} },
        },
        action: "increment",
        input: { by: 2 },
      })
    );
    await Effect.runPromise(graph.releaseNode(ready.nodeId));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "drivers/async-authoring");

    expect(refresh._tag).toBe("Success");
    expect(action).toMatchObject({ _tag: "Success", value: { count: 2 } });
    expect(released).toEqual(["released"]);
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.result).toBeUndefined();
  });

  test("async driver refresh rejection is a typed driver boundary failure", async () => {
    const cause = new TypeError("refresh transport rejected");
    type AsyncRefreshFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: AsyncAuthoringResult;
    }>;

    class AsyncRefreshFailureNode extends NodeBase<AsyncRefreshFailureSpec> {
      static readonly spec = resourceSpec<AsyncRefreshFailureSpec>({
        tag: "drivers/async-refresh-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Async<AsyncRefreshFailureSpec>({
          acquire: Driver.Acquire(() => ({ count: 0, label: "initial" })),
          refresh: Driver.Refresh(async () => {
            throw cause;
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: AsyncRefreshFailureNode, args: {} }));
    const refresh = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: AsyncRefreshFailureNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "drivers/async-refresh-failure");

    expect(refresh._tag).toBe("Failure");
    expect(refresh._tag === "Failure" ? refresh.error : undefined).toBeInstanceOf(RefreshFailed);

    const failure = refresh._tag === "Failure" ? refresh.error : undefined;
    const boundaryFailure = failure instanceof RefreshFailed ? failure.cause : undefined;
    expect(boundaryFailure).toBeInstanceOf(DriverPromiseFailed);
    expect((boundaryFailure as DriverPromiseFailed | undefined)?.cause).toBe(cause);
    expect(node?.result).toEqual({ count: 0, label: "initial" });
  });
});
