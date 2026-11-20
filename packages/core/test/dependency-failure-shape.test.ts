// Pins the failure a dependent sees when exactly one dependency is not ready:
// the readiness path, the action path, a refresh, and a refreshDep each report
// the single DependencyFailed itself (never an aggregate) wrapping the
// dependency's own failure object.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { DependencyResultExpired } from "../src/graph";
import {
  AcquireFailed,
  type ActionContract,
  ActionFailed,
  type Dep,
  DependencyFailed,
  DependencyRefreshFailed,
  Driver,
  DriverPromiseFailed,
  dep,
  dependencies,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  RefreshFailed,
  resourceSpec,
  resultCommit,
  serviceSpec,
} from "./graphTestFixtures";

type LeafSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly fail: boolean };
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
}>;

const leafCause = { _tag: "LeafRefused" } as const;

class Leaf extends NodeBase<LeafSpec> {
  static readonly spec = serviceSpec.async<LeafSpec>({
    tag: "dependency-failure-shape/leaf",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire((ctx) => {
      if (ctx.args.fail) throw leafCause;
      return 1;
    }),
  });
}

class Other extends NodeBase<LeafSpec> {
  static readonly spec = serviceSpec.async<LeafSpec>({
    tag: "dependency-failure-shape/other",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultValidity: { _tag: "Manual" },
    acquire: Driver.Acquire(() => 2),
    refresh: Driver.Refresh((ctx) => {
      ctx.setResult(resultCommit(3, { validity: { _tag: "Expired", expiredAt: 1 } }));
    }),
  });
}

type ParentSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly fail: boolean };
  readonly key: Key.Singleton;
  readonly deps: { readonly leaf: Dep<typeof Leaf>; readonly other: Dep<typeof Other> };
  readonly result: number;
  readonly actions: { readonly noop: ActionContract<void, number> };
}>;

class Parent extends NodeBase<ParentSpec> {
  static readonly spec = resourceSpec.async<ParentSpec>({
    tag: "dependency-failure-shape/parent",
    key: () => Key.singleton(),
    dependencies: dependencies((args) => ({
      leaf: dep(Leaf, { fail: args.fail }),
      other: dep(Other, { fail: false }),
    })),
    acquire: Driver.Acquire(() => 0),
    refresh: Driver.Refresh(async (ctx) => {
      await ctx.refreshDep("other");
      ctx.setResult(1);
    }),
    actions: { noop: Driver.Action(() => 0) },
  });
}

/** A ready Parent whose `leaf` dependency the caller then releases. */
async function readyParentWithReleasedLeaf() {
  const graph = makeInMemoryGraphSystem();
  const parent = await Effect.runPromise(
    graph.ensureReadyNode({ spec: Parent, args: { fail: false } })
  );
  const leafId = graph.resolveNodeIdSync({ spec: Leaf, args: { fail: false } });
  await Effect.runPromise(graph.releaseNode(leafId));
  return { graph, parentId: parent.nodeId, leafId };
}

test("readiness reports one failed dependency as that DependencyFailed", async () => {
  const graph = makeInMemoryGraphSystem();
  await Effect.runPromise(graph.ensureReadyNode({ spec: Parent, args: { fail: true } }));
  const snapshot = await Effect.runPromise(graph.snapshot());
  const failure = snapshot.nodes.find(
    (node) => node.tag === "dependency-failure-shape/parent"
  )?.failure;

  expect(failure).toBeInstanceOf(DependencyFailed);
  if (!(failure instanceof DependencyFailed)) throw new Error("Expected DependencyFailed.");
  expect(failure.dependency).toBe("leaf");
  expect(failure.cause).toBeInstanceOf(AcquireFailed);
});

test("an action reports one not-ready dependency as that DependencyFailed", async () => {
  const { graph, parentId, leafId } = await readyParentWithReleasedLeaf();
  const result = await Effect.runPromise(
    graph.runAction({
      target: { _tag: "NodeId", nodeId: parentId },
      action: "noop",
      input: undefined,
    })
  );
  const failure = result._tag === "Failure" ? result.error : undefined;
  const cause = failure instanceof ActionFailed ? failure.cause : undefined;

  expect(cause).toBeInstanceOf(DependencyFailed);
  if (!(cause instanceof DependencyFailed)) throw new Error("Expected DependencyFailed.");
  expect(cause.dependency).toBe("leaf");
  expect(cause.dependencyNodeId).toBe(leafId);
  expect(cause.nodeId).toBe(parentId);
});

test("a refresh reports one not-ready dependency as that DependencyFailed", async () => {
  const { graph, parentId, leafId } = await readyParentWithReleasedLeaf();
  const result = await Effect.runPromise(
    graph.refreshNode({ target: { _tag: "NodeId", nodeId: parentId } })
  );
  const failure = result._tag === "Failure" ? result.error : undefined;

  expect(failure).toBeInstanceOf(RefreshFailed);
  if (!(failure instanceof RefreshFailed)) throw new Error("Expected RefreshFailed.");
  // The refresh reads its dependencies before the driver runs, so a released
  // dependency fails the refresh as a DependencyFailed, not a refreshDep failure.
  expect(failure.cause).toBeInstanceOf(DependencyFailed);
  expect(failure.cause).not.toBeInstanceOf(DependencyRefreshFailed);
  if (!(failure.cause instanceof DependencyFailed)) throw new Error("Expected DependencyFailed.");
  expect(failure.cause.dependency).toBe("leaf");
  expect(failure.cause.dependencyNodeId).toBe(leafId);
});

test("a refreshDep whose refreshed dependency reads expired wraps the DependencyFailed it read", async () => {
  const graph = makeInMemoryGraphSystem();
  const parent = await Effect.runPromise(
    graph.ensureReadyNode({ spec: Parent, args: { fail: false } })
  );
  const otherId = graph.resolveNodeIdSync({ spec: Other, args: { fail: false } });
  const result = await Effect.runPromise(
    graph.refreshNode({ target: { _tag: "NodeId", nodeId: parent.nodeId } })
  );
  const failure = result._tag === "Failure" ? result.error : undefined;
  // The async driver's rejected refreshDep promise arrives as DriverPromiseFailed.
  const rejection = failure instanceof RefreshFailed ? failure.cause : undefined;
  const refreshDep = rejection instanceof DriverPromiseFailed ? rejection.cause : undefined;

  expect(refreshDep).toBeInstanceOf(DependencyRefreshFailed);
  if (!(refreshDep instanceof DependencyRefreshFailed))
    throw new Error("Expected DependencyRefreshFailed.");
  expect(refreshDep.dependency).toBe("other");
  expect(refreshDep.cause).toBeInstanceOf(DependencyFailed);
  if (!(refreshDep.cause instanceof DependencyFailed))
    throw new Error("Expected DependencyFailed.");
  expect(refreshDep.cause.dependency).toBe("other");
  expect(refreshDep.cause.dependencyNodeId).toBe(otherId);
  expect(refreshDep.cause.cause).toBeInstanceOf(DependencyResultExpired);
});
