import { describe, expect, test } from "bun:test";
import { Fiber } from "effect";
import { developmentChecks } from "../src/graph/planning/developmentChecks";
import {
  CycleDetected,
  Deferred,
  type Dep,
  DependencyDefinitionFailed,
  Driver,
  dep,
  dependencies,
  Effect,
  GraphInvariantViolation,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  serviceSpec,
} from "./graphTestFixtures";

type LeafSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

let leafDependencyCalls = 0;

class FastPathLeafNode extends NodeBase<LeafSpec> {
  static readonly spec = serviceSpec.effect<LeafSpec>({
    tag: "services/fast-path-leaf",
    key: () => Key.singleton(),
    dependencies: dependencies(() => {
      leafDependencyCalls += 1;
      return {};
    }),
    acquire: Driver.Acquire(() => Effect.succeed("leaf")),
  });
}

/**
 * Builds root -> parent -> leaf where the parent's release hangs until the
 * test interrupts it. Eviction cleans up dependents first, so interrupting an
 * eviction of the leaf there has removed the root (when planned) and leaves
 * the parent and the leaf Found and wired.
 */
function makeHangingChain() {
  const parentReleaseStarted = Effect.runSync(Deferred.make<void>());

  type ParentSpec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: { readonly leaf: Dep<typeof FastPathLeafNode> };
    readonly result: string;
  }>;

  class HangingReleaseParentNode extends NodeBase<ParentSpec> {
    static readonly spec = resourceSpec.effect<ParentSpec>({
      tag: "resources/fast-path-hanging-parent",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ leaf: dep(FastPathLeafNode, {}) })),
      acquire: Driver.Acquire((ctx) => Effect.succeed(`parent:${ctx.deps.leaf.result}`)),
      release: Driver.Release(() =>
        Deferred.succeed(parentReleaseStarted, undefined).pipe(Effect.andThen(Effect.never))
      ),
    });
  }

  type RootSpec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: { readonly parent: Dep<typeof HangingReleaseParentNode> };
    readonly result: string;
  }>;

  class ChainRootNode extends NodeBase<RootSpec> {
    static readonly spec = resourceSpec.effect<RootSpec>({
      tag: "resources/fast-path-root",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ parent: dep(HangingReleaseParentNode, {}) })),
      acquire: Driver.Acquire((ctx) => Effect.succeed(`root:${ctx.deps.parent.result}`)),
    });
  }

  return {
    parentReleaseStarted,
    parentRequest: { spec: HangingReleaseParentNode, args: {} },
    rootRequest: { spec: ChainRootNode, args: {} },
  };
}

async function tearLeafOut(
  graph: ReturnType<typeof makeInMemoryGraphSystem>,
  parentReleaseStarted: Deferred.Deferred<void>
) {
  const wired = await Effect.runPromise(graph.snapshot());
  const leaf = wired.nodes.find((node) => node.tag === "services/fast-path-leaf");
  if (leaf === undefined) throw new Error("Expected the leaf node.");
  const eviction = Effect.runFork(
    graph.evictSubgraph({ rootNodeIds: [leaf.nodeId], mode: "selfAndDependents" })
  );
  await Effect.runPromise(Deferred.await(parentReleaseStarted));
  await Effect.runPromise(Fiber.interrupt(eviction));
  return { wired, leafNodeId: leaf.nodeId };
}

const sortedNodeIds = (snapshot: { readonly nodes: ReadonlyArray<{ readonly nodeId: string }> }) =>
  snapshot.nodes.map((node) => node.nodeId).sort();

const sortedEdges = (snapshot: {
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}) => snapshot.edges.map((edge) => `${edge.from}->${edge.to}`).sort();

async function withReplanCheck(enabled: boolean, run: () => Promise<void>): Promise<void> {
  const previous = developmentChecks.replanDependencies;
  developmentChecks.replanDependencies = enabled;
  try {
    await run();
  } finally {
    developmentChecks.replanDependencies = previous;
  }
}

const withProductionChecks = (run: () => Promise<void>) => withReplanCheck(false, run);

const checkModes = [
  { name: "development", enabled: true },
  { name: "production", enabled: false },
] as const;

type GraphSystem = ReturnType<typeof makeInMemoryGraphSystem>;

async function withGraph(run: (graph: GraphSystem) => Promise<void>): Promise<void> {
  const graph = makeInMemoryGraphSystem();
  try {
    await run(graph);
  } finally {
    await Effect.runPromise(graph.stop());
  }
}

/** Evicts a node nothing else depends on, which only bumps the wiring generation. */
async function evictUnrelatedNode(graph: GraphSystem): Promise<void> {
  const unrelated = await Effect.runPromise(graph.ensureNode({ spec: UnrelatedNode, args: {} }));
  await Effect.runPromise(
    graph.evictSubgraph({ rootNodeIds: [unrelated.nodeId], mode: "selfAndDependents" })
  );
}

const invalidError = (read: { readonly _tag: string }) =>
  "error" in read && read._tag === "Invalid" ? read.error : undefined;

class UnrelatedNode extends NodeBase<LeafSpec> {
  static readonly spec = serviceSpec.effect<LeafSpec>({
    tag: "services/fast-path-unrelated",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed("unrelated")),
  });
}

type SingletonSpec<TDeps, TArgs = Record<string, never>> = NodeSpec<{
  readonly mode: "effect";
  readonly args: TArgs;
  readonly key: Key.Singleton;
  readonly deps: TDeps;
  readonly result: string;
}>;

class SelfCycleNode extends NodeBase<SingletonSpec<{ readonly self: Dep<typeof SelfCycleNode> }>> {
  static readonly spec = resourceSpec.effect<
    SingletonSpec<{ readonly self: Dep<typeof SelfCycleNode> }>
  >({
    tag: "resources/fast-path-self-cycle",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ self: dep(SelfCycleNode, {}) })),
    acquire: Driver.Acquire(() => Effect.succeed("self")),
  });
}

class CycleRootNode extends NodeBase<SingletonSpec<{ readonly child: Dep<typeof SelfCycleNode> }>> {
  static readonly spec = resourceSpec.effect<
    SingletonSpec<{ readonly child: Dep<typeof SelfCycleNode> }>
  >({
    tag: "resources/fast-path-cycle-root",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ child: dep(SelfCycleNode, {}) })),
    acquire: Driver.Acquire(() => Effect.succeed("cycle-root")),
  });
}

class CycleFirstNode extends NodeBase<
  SingletonSpec<{ readonly second: Dep<typeof CycleSecondNode> }>
> {
  static readonly spec = resourceSpec.effect<
    SingletonSpec<{ readonly second: Dep<typeof CycleSecondNode> }>
  >({
    tag: "resources/fast-path-cycle-first",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ second: dep(CycleSecondNode, {}) })),
    acquire: Driver.Acquire(() => Effect.succeed("first")),
  });
}

class CycleSecondNode extends NodeBase<
  SingletonSpec<{ readonly first: Dep<typeof CycleFirstNode> }>
> {
  static readonly spec = resourceSpec.effect<
    SingletonSpec<{ readonly first: Dep<typeof CycleFirstNode> }>
  >({
    tag: "resources/fast-path-cycle-second",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ first: dep(CycleFirstNode, {}) })),
    acquire: Driver.Acquire(() => Effect.succeed("second")),
  });
}

let throwingDependencyAcquires = 0;

class ThrowingDependenciesNode extends NodeBase<SingletonSpec<Record<string, never>>> {
  static readonly spec = serviceSpec.effect<SingletonSpec<Record<string, never>>>({
    tag: "services/fast-path-throwing-dependencies",
    key: () => Key.singleton(),
    dependencies: dependencies((): Record<string, never> => {
      throw new Error("dependencies cannot be defined");
    }),
    acquire: Driver.Acquire(() => {
      throwingDependencyAcquires += 1;
      return Effect.succeed("throwing");
    }),
  });
}

class OverThrowingNode extends NodeBase<
  SingletonSpec<{ readonly child: Dep<typeof ThrowingDependenciesNode> }>
> {
  static readonly spec = serviceSpec.effect<
    SingletonSpec<{ readonly child: Dep<typeof ThrowingDependenciesNode> }>
  >({
    tag: "services/fast-path-over-throwing",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ child: dep(ThrowingDependenciesNode, {}) })),
    acquire: Driver.Acquire(() => Effect.succeed("over-throwing")),
  });
}

type NonFiniteKeySpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Structure<number>;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class NonFiniteKeyNode extends NodeBase<NonFiniteKeySpec> {
  static readonly spec = serviceSpec.effect<NonFiniteKeySpec>({
    tag: "services/fast-path-non-finite-key",
    key: () => Key.structure(Number.NaN),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed("non-finite")),
  });
}

class OverNonFiniteKeyNode extends NodeBase<
  SingletonSpec<{ readonly child: Dep<typeof NonFiniteKeyNode> }>
> {
  static readonly spec = serviceSpec.effect<
    SingletonSpec<{ readonly child: Dep<typeof NonFiniteKeyNode> }>
  >({
    tag: "services/fast-path-over-non-finite-key",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ child: dep(NonFiniteKeyNode, {}) })),
    acquire: Driver.Acquire(() => Effect.succeed("over-non-finite")),
  });
}

type IgnoredArgsLeafSpec = SingletonSpec<Record<string, never>, { readonly ignored: unknown }>;

class IgnoredArgsLeafNode extends NodeBase<IgnoredArgsLeafSpec> {
  static readonly spec = serviceSpec.effect<IgnoredArgsLeafSpec>({
    tag: "services/fast-path-ignored-args-leaf",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed("ignored-args-leaf")),
  });
}

type NonCanonicalParentSpec = SingletonSpec<
  { readonly child: Dep<typeof IgnoredArgsLeafNode> },
  { readonly nonCanonical: boolean }
>;

class NonCanonicalParentNode extends NodeBase<NonCanonicalParentSpec> {
  static readonly spec = serviceSpec.effect<NonCanonicalParentSpec>({
    tag: "services/fast-path-non-canonical-parent",
    key: () => Key.singleton(),
    dependencies: dependencies((args) => ({
      child: dep(IgnoredArgsLeafNode, { ignored: args.nonCanonical ? Number.NaN : 0 }),
    })),
    acquire: Driver.Acquire(() => Effect.succeed("non-canonical-parent")),
  });
}

describe("same-identity re-plan", () => {
  // 0.6 intended change: eviction cleans up dependents first, so an interrupted eviction leaves the dependency in place.
  test("re-planning a parent an interrupted eviction left in place keeps its dependency", async () => {
    const { parentReleaseStarted, parentRequest } = makeHangingChain();
    const graph = makeInMemoryGraphSystem({ driverTimeouts: { release: 60_000 } });
    const parent = await Effect.runPromise(graph.ensureReadyNode(parentRequest));
    const { leafNodeId } = await tearLeafOut(graph, parentReleaseStarted);

    const torn = await Effect.runPromise(graph.snapshot());
    expect(sortedNodeIds(torn)).toEqual([parent.nodeId, leafNodeId].sort());
    expect(torn.edges).toEqual([{ from: parent.nodeId, to: leafNodeId, dependency: "leaf" }]);

    const replanned = await Effect.runPromise(graph.ensureNode(parentRequest));
    const healed = await Effect.runPromise(graph.snapshot());

    expect(replanned.nodeId).toBe(parent.nodeId);
    expect(sortedNodeIds(healed)).toEqual([parent.nodeId, leafNodeId].sort());
    expect(healed.edges).toEqual([{ from: parent.nodeId, to: leafNodeId, dependency: "leaf" }]);
  });

  // 0.6 intended change: eviction cleans up dependents first, so the interrupted eviction removed the root, not the leaf.
  test("re-planning a root an interrupted eviction removed re-wires it over the dependencies left in place", async () => {
    const { parentReleaseStarted, rootRequest } = makeHangingChain();
    const graph = makeInMemoryGraphSystem({ driverTimeouts: { release: 60_000 } });
    await Effect.runPromise(graph.ensureReadyNode(rootRequest));
    const { wired } = await tearLeafOut(graph, parentReleaseStarted);

    const torn = await Effect.runPromise(graph.snapshot());
    expect(torn.nodes).toHaveLength(2);
    expect(torn.edges).toHaveLength(1);

    await withProductionChecks(async () => {
      await Effect.runPromise(graph.ensureNode(rootRequest));
    });
    const healed = await Effect.runPromise(graph.snapshot());

    expect(sortedNodeIds(healed)).toEqual(sortedNodeIds(wired));
    expect(sortedEdges(healed)).toEqual(sortedEdges(wired));
  });

  // A "dependents" eviction whose roots include both a dependency and its
  // dependent's dependent removes only the node between them: the retained
  // root is Found while its dependency is gone.
  for (const mode of checkModes) {
    test(`re-planning a root whose dependency a dependents eviction removed re-creates it (${mode.name} checks)`, async () => {
      const { rootRequest } = makeHangingChain();
      const graph = makeInMemoryGraphSystem({ driverTimeouts: { release: 10 } });
      const root = await Effect.runPromise(graph.ensureNode(rootRequest));
      const wired = await Effect.runPromise(graph.snapshot());
      const leaf = wired.nodes.find((node) => node.tag === "services/fast-path-leaf");
      if (leaf === undefined) throw new Error("Expected the leaf node.");

      await Effect.runPromise(
        graph.evictSubgraph({ rootNodeIds: [leaf.nodeId, root.nodeId], mode: "dependents" })
      );
      const torn = await Effect.runPromise(graph.snapshot());
      expect(sortedNodeIds(torn)).toEqual([root.nodeId, leaf.nodeId].sort());
      expect(torn.edges).toEqual([]);

      await withReplanCheck(mode.enabled, async () => {
        await Effect.runPromise(graph.ensureNode(rootRequest));
      });
      const healed = await Effect.runPromise(graph.snapshot());

      expect(sortedNodeIds(healed)).toEqual(sortedNodeIds(wired));
      expect(sortedEdges(healed)).toEqual(sortedEdges(wired));
    });
  }

  test("re-planning after a completed eviction re-creates the evicted subgraph", async () => {
    const { parentRequest } = makeHangingChain();
    const graph = makeInMemoryGraphSystem({ driverTimeouts: { release: 10 } });
    await Effect.runPromise(graph.ensureNode(parentRequest));
    const wired = await Effect.runPromise(graph.snapshot());
    const leaf = wired.nodes.find((node) => node.tag === "services/fast-path-leaf");
    if (leaf === undefined) throw new Error("Expected the leaf node.");

    await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [leaf.nodeId], mode: "selfAndDependents" })
    );
    expect((await Effect.runPromise(graph.snapshot())).nodes).toEqual([]);

    await Effect.runPromise(graph.ensureNode(parentRequest));
    const replanned = await Effect.runPromise(graph.snapshot());

    expect(sortedNodeIds(replanned)).toEqual(sortedNodeIds(wired));
    expect(sortedEdges(replanned)).toEqual(sortedEdges(wired));
  });

  // 0.6 intended change: re-planning a wired node no longer re-evaluates its dependency closure.
  test("re-planning a wired node does not re-plan its dependencies", async () => {
    let parentDependencyCalls = 0;
    type CountingParentSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: { readonly leaf: Dep<typeof FastPathLeafNode> };
      readonly result: string;
    }>;

    class CountingParentNode extends NodeBase<CountingParentSpec> {
      static readonly spec = resourceSpec.effect<CountingParentSpec>({
        tag: "resources/fast-path-counting-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => {
          parentDependencyCalls += 1;
          return { leaf: dep(FastPathLeafNode, {}) };
        }),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`parent:${ctx.deps.leaf.result}`)),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const request = { spec: CountingParentNode, args: {} };
    await Effect.runPromise(graph.ensureNode(request));

    // Development and test builds confirm the requested node's own dependencies.
    parentDependencyCalls = 0;
    leafDependencyCalls = 0;
    await Effect.runPromise(graph.ensureNode(request));
    expect(developmentChecks.replanDependencies).toBe(true);
    expect(parentDependencyCalls).toBe(1);
    expect(leafDependencyCalls).toBe(0);

    await withProductionChecks(async () => {
      parentDependencyCalls = 0;
      leafDependencyCalls = 0;
      await Effect.runPromise(graph.ensureReadyNode(request));
      await Effect.runPromise(graph.ensureNode(request));
      expect(parentDependencyCalls).toBe(0);
      expect(leafDependencyCalls).toBe(0);
    });
  });

  // 0.6 intended change: production builds trust a pure dependencies(args) and skip the mismatch check.
  test("production re-plan of the same key with dependency-changing args keeps the wired cell", async () => {
    type SwitchingSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: { readonly id: string; readonly target: string };
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: { readonly target: Dep<typeof FastPathLeafNode> };
      readonly result: string;
    }>;

    class TargetNode extends NodeBase<LeafSpec> {
      static readonly spec = serviceSpec.effect<LeafSpec>({
        tag: "services/fast-path-target",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("target")),
      });
    }

    class SwitchingNode extends NodeBase<SwitchingSpec> {
      static readonly spec = resourceSpec.effect<SwitchingSpec>({
        tag: "resources/fast-path-switching",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies((args) => ({
          target: args.target === "leaf" ? dep(FastPathLeafNode, {}) : dep(TargetNode, {}),
        })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`switching:${ctx.deps.target.result}`)),
      });
    }

    const developmentGraph = makeInMemoryGraphSystem();
    await Effect.runPromise(
      developmentGraph.ensureNode({ spec: SwitchingNode, args: { id: "a", target: "leaf" } })
    );
    const developmentRead = await Effect.runPromise(
      developmentGraph.ensureNode({ spec: SwitchingNode, args: { id: "a", target: "other" } })
    );
    expect(developmentRead._tag).toBe("Invalid");
    expect(developmentRead._tag === "Invalid" ? developmentRead.error : undefined).toBeInstanceOf(
      GraphInvariantViolation
    );

    await withProductionChecks(async () => {
      const graph = makeInMemoryGraphSystem();
      const first = await Effect.runPromise(
        graph.ensureNode({ spec: SwitchingNode, args: { id: "a", target: "leaf" } })
      );
      const wired = await Effect.runPromise(graph.snapshot());
      const second = await Effect.runPromise(
        graph.ensureNode({ spec: SwitchingNode, args: { id: "a", target: "other" } })
      );
      const after = await Effect.runPromise(graph.snapshot());

      expect(second.nodeId).toBe(first.nodeId);
      expect(second._tag).not.toBe("Invalid");
      expect(second.status._tag).not.toBe("Invalid");
      expect(sortedNodeIds(after)).toEqual(sortedNodeIds(wired));
      expect(sortedEdges(after)).toEqual(sortedEdges(wired));
    });
  });
});

describe("re-plan after a planning failure", () => {
  for (const mode of checkModes) {
    test(`a released self-cycle stays Invalid on re-plan (${mode.name})`, async () => {
      await withReplanCheck(mode.enabled, () =>
        withGraph(async (graph) => {
          const request = { spec: SelfCycleNode, args: {} };
          const first = await Effect.runPromise(graph.ensureNode(request));
          expect(first._tag).toBe("Invalid");
          await Effect.runPromise(graph.releaseNode(first.nodeId));

          const second = await Effect.runPromise(graph.ensureNode(request));
          expect(second._tag).toBe("Invalid");
          expect(invalidError(second)).toBeInstanceOf(CycleDetected);
        })
      );
    });

    test(`a released two-node cycle stays Invalid on re-plan (${mode.name})`, async () => {
      await withReplanCheck(mode.enabled, () =>
        withGraph(async (graph) => {
          const request = { spec: CycleFirstNode, args: {} };
          const first = await Effect.runPromise(graph.ensureNode(request));
          expect(first._tag).toBe("Invalid");
          const second = graph.resolveNodeIdSync({ spec: CycleSecondNode, args: {} });
          await Effect.runPromise(graph.releaseNode(first.nodeId));
          await Effect.runPromise(graph.releaseNode(second));

          const replanned = await Effect.runPromise(graph.ensureNode(request));
          expect(replanned._tag).toBe("Invalid");
          expect(invalidError(replanned)).toBeInstanceOf(CycleDetected);
          const ready = await Effect.runPromise(graph.ensureReadyNode(request));
          expect(ready._tag).toBe("Invalid");
        })
      );
    });

    test(`re-planning an ancestor re-checks a released cyclic dependency (${mode.name})`, async () => {
      await withReplanCheck(mode.enabled, () =>
        withGraph(async (graph) => {
          const request = { spec: CycleRootNode, args: {} };
          await Effect.runPromise(graph.ensureNode(request));
          const child = graph.resolveNodeIdSync({ spec: SelfCycleNode, args: {} });
          await Effect.runPromise(graph.releaseNode(child));

          await Effect.runPromise(graph.ensureNode(request));
          const snapshot = await Effect.runPromise(graph.snapshot());
          expect(snapshot.nodes.find((node) => node.nodeId === child)?.status._tag).toBe("Invalid");
        })
      );
    });

    test(`a parent over a released dependency whose dependencies() throws stays failed (${mode.name})`, async () => {
      await withReplanCheck(mode.enabled, () =>
        withGraph(async (graph) => {
          throwingDependencyAcquires = 0;
          const request = { spec: OverThrowingNode, args: {} };
          expect((await Effect.runPromise(graph.ensureReadyNode(request)))._tag).toBe("Error");
          const child = graph.resolveNodeIdSync({ spec: ThrowingDependenciesNode, args: {} });
          await Effect.runPromise(graph.releaseNode(child));

          expect((await Effect.runPromise(graph.ensureReadyNode(request)))._tag).toBe("Error");
          expect(throwingDependencyAcquires).toBe(0);
        })
      );
    });

    for (const unrelatedEviction of [false, true]) {
      test(`a parent over a released dependency with an invalid key stays failed (${mode.name}, unrelated eviction: ${unrelatedEviction})`, async () => {
        await withReplanCheck(mode.enabled, () =>
          withGraph(async (graph) => {
            const request = { spec: OverNonFiniteKeyNode, args: {} };
            await Effect.runPromise(graph.ensureNode(request));
            const child = graph.resolveNodeIdSync({ spec: NonFiniteKeyNode, args: {} });
            await Effect.runPromise(graph.releaseNode(child));
            if (unrelatedEviction) await evictUnrelatedNode(graph);

            expect((await Effect.runPromise(graph.ensureReadyNode(request)))._tag).toBe("Error");
          })
        );
      });
    }
  }

  test("re-planning a node that is already Invalid leaves other wired nodes on the fast path", async () => {
    let parentDependencyCalls = 0;
    type CountingParentSpec = SingletonSpec<{ readonly leaf: Dep<typeof FastPathLeafNode> }>;

    class InvalidNeighborParentNode extends NodeBase<CountingParentSpec> {
      static readonly spec = resourceSpec.effect<CountingParentSpec>({
        tag: "resources/fast-path-invalid-neighbor-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => {
          parentDependencyCalls += 1;
          return { leaf: dep(FastPathLeafNode, {}) };
        }),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`parent:${ctx.deps.leaf.result}`)),
      });
    }

    await withProductionChecks(() =>
      withGraph(async (graph) => {
        const request = { spec: InvalidNeighborParentNode, args: {} };
        await Effect.runPromise(graph.ensureNode(request));
        for (let call = 0; call < 3; call += 1) {
          await Effect.runPromise(graph.ensureNode({ spec: NonFiniteKeyNode, args: {} }));
          await Effect.runPromise(graph.ensureNode({ spec: OverNonFiniteKeyNode, args: {} }));
        }

        parentDependencyCalls = 0;
        await Effect.runPromise(graph.ensureNode(request));
        expect(parentDependencyCalls).toBe(0);
      })
    );
  });

  test("a development re-plan rejects dependency args that are not canonical", async () => {
    expect(developmentChecks.replanDependencies).toBe(true);
    await withGraph(async (graph) => {
      await Effect.runPromise(
        graph.ensureNode({ spec: NonCanonicalParentNode, args: { nonCanonical: false } })
      );
      const replanned = await Effect.runPromise(
        graph.ensureNode({ spec: NonCanonicalParentNode, args: { nonCanonical: true } })
      );
      expect(replanned._tag).toBe("Invalid");
      expect(invalidError(replanned)).toBeInstanceOf(DependencyDefinitionFailed);
    });
  });

  test("a full re-plan after an unrelated eviction rejects dependency args that are not canonical", async () => {
    await withGraph(async (graph) => {
      await Effect.runPromise(
        graph.ensureNode({ spec: NonCanonicalParentNode, args: { nonCanonical: false } })
      );
      await evictUnrelatedNode(graph);
      const replanned = await Effect.runPromise(
        graph.ensureNode({ spec: NonCanonicalParentNode, args: { nonCanonical: true } })
      );
      expect(replanned._tag).toBe("Invalid");
    });
  });

  // 0.6 intended change: production trusts a pure resolver until a full re-plan runs it again.
  test("production keeps a node whose resolver changes its answer until an unrelated eviction forces a full re-plan", async () => {
    type SwitchingSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: { readonly id: string; readonly target: string };
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: { readonly target: Dep<typeof FastPathLeafNode> };
      readonly result: string;
    }>;

    class SwitchingTargetNode extends NodeBase<LeafSpec> {
      static readonly spec = serviceSpec.effect<LeafSpec>({
        tag: "services/fast-path-eviction-switching-target",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("target")),
      });
    }

    class EvictionSwitchingNode extends NodeBase<SwitchingSpec> {
      static readonly spec = resourceSpec.effect<SwitchingSpec>({
        tag: "resources/fast-path-eviction-switching",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies((args) => ({
          target: args.target === "leaf" ? dep(FastPathLeafNode, {}) : dep(SwitchingTargetNode, {}),
        })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`switching:${ctx.deps.target.result}`)),
      });
    }

    await withProductionChecks(() =>
      withGraph(async (graph) => {
        await Effect.runPromise(
          graph.ensureNode({ spec: EvictionSwitchingNode, args: { id: "a", target: "leaf" } })
        );
        const changed = { spec: EvictionSwitchingNode, args: { id: "a", target: "other" } };

        const kept = await Effect.runPromise(graph.ensureNode(changed));
        expect(kept._tag).toBe("Idle");

        await evictUnrelatedNode(graph);
        const replanned = await Effect.runPromise(graph.ensureNode(changed));
        expect(replanned._tag).toBe("Invalid");
        expect(invalidError(replanned)).toBeInstanceOf(GraphInvariantViolation);
      })
    );
  });

  // 0.6 intended change: production does not call a wired node's resolver again, so a resolver that now throws goes unnoticed.
  test("a resolver that throws on re-plan keeps the wired node in production and invalidates it in development", async () => {
    let throwOnResolve = false;
    type ToggleSpec = SingletonSpec<{ readonly leaf: Dep<typeof FastPathLeafNode> }>;

    class ToggleThrowingNode extends NodeBase<ToggleSpec> {
      static readonly spec = resourceSpec.effect<ToggleSpec>({
        tag: "resources/fast-path-toggle-throwing",
        key: () => Key.singleton(),
        dependencies: dependencies(() => {
          if (throwOnResolve) throw new Error("resolver now throws");
          return { leaf: dep(FastPathLeafNode, {}) };
        }),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`toggle:${ctx.deps.leaf.result}`)),
      });
    }
    const request = { spec: ToggleThrowingNode, args: {} };

    await withProductionChecks(() =>
      withGraph(async (graph) => {
        throwOnResolve = false;
        await Effect.runPromise(graph.ensureNode(request));
        throwOnResolve = true;
        expect((await Effect.runPromise(graph.ensureNode(request)))._tag).toBe("Idle");
        expect((await Effect.runPromise(graph.ensureReadyNode(request)))._tag).toBe("Ready");
      })
    );

    await withGraph(async (graph) => {
      throwOnResolve = false;
      await Effect.runPromise(graph.ensureNode(request));
      throwOnResolve = true;
      const replanned = await Effect.runPromise(graph.ensureNode(request));
      expect(replanned._tag).toBe("Invalid");
      expect(invalidError(replanned)).toBeInstanceOf(DependencyDefinitionFailed);
    });
  });

  test("a new parent over an already-wired dependency records its edge and is evicted with it", async () => {
    type SecondParentSpec = SingletonSpec<{ readonly leaf: Dep<typeof FastPathLeafNode> }>;

    class FirstParentNode extends NodeBase<SecondParentSpec> {
      static readonly spec = resourceSpec.effect<SecondParentSpec>({
        tag: "resources/fast-path-first-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ leaf: dep(FastPathLeafNode, {}) })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`first:${ctx.deps.leaf.result}`)),
      });
    }

    class SecondParentNode extends NodeBase<SecondParentSpec> {
      static readonly spec = resourceSpec.effect<SecondParentSpec>({
        tag: "resources/fast-path-second-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ leaf: dep(FastPathLeafNode, {}) })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`second:${ctx.deps.leaf.result}`)),
      });
    }

    await withGraph(async (graph) => {
      const first = await Effect.runPromise(
        graph.ensureReadyNode({ spec: FirstParentNode, args: {} })
      );
      const leaf = graph.resolveNodeIdSync({ spec: FastPathLeafNode, args: {} });
      const second = await Effect.runPromise(
        graph.ensureReadyNode({ spec: SecondParentNode, args: {} })
      );
      expect(second._tag).toBe("Ready");
      expect(sortedEdges(await Effect.runPromise(graph.snapshot()))).toEqual(
        [`${first.nodeId}->${leaf}`, `${second.nodeId}->${leaf}`].sort()
      );

      await Effect.runPromise(
        graph.evictSubgraph({ rootNodeIds: [leaf], mode: "selfAndDependents" })
      );
      const evicted = await Effect.runPromise(graph.snapshot());
      expect(evicted.nodes).toEqual([]);
      expect(evicted.edges).toEqual([]);
    });
  });

  test("a failed dependency retries through a wired parent", async () => {
    let attempts = 0;
    class RetryingNode extends NodeBase<LeafSpec> {
      static readonly spec = serviceSpec.effect<LeafSpec>({
        tag: "services/fast-path-retrying",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => {
          attempts += 1;
          return attempts === 1 ? Effect.fail("first attempt") : Effect.succeed("retried");
        }),
      });
    }
    type RetryingParentSpec = SingletonSpec<{ readonly child: Dep<typeof RetryingNode> }>;
    class RetryingParentNode extends NodeBase<RetryingParentSpec> {
      static readonly spec = serviceSpec.effect<RetryingParentSpec>({
        tag: "services/fast-path-retrying-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ child: dep(RetryingNode, {}) })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(`parent:${ctx.deps.child.result}`)),
      });
    }

    await withGraph(async (graph) => {
      const request = { spec: RetryingParentNode, args: {} };
      expect((await Effect.runPromise(graph.ensureReadyNode(request)))._tag).toBe("Error");
      expect((await Effect.runPromise(graph.ensureReadyNode(request)))._tag).toBe("Ready");
      expect(attempts).toBe(2);
    });
  });
});
