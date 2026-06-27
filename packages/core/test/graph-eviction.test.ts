import { describe, expect, test } from "bun:test";
import {
  type ActionContract,
  Deferred,
  type Dep,
  DisposerFailed,
  Driver,
  dep,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  NodeEvicted,
  type NodeSpec,
  ProfileNode,
  resourceSpec,
  serviceSpec,
} from "./graphTestFixtures";

describe("graph eviction", () => {
  test("evicting a dependency removes dependents and graph edges", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ProfileNode, args: {} }));
    const wired = await Effect.runPromise(graph.snapshot());
    const transport = wired.nodes.find((node) => node.tag === "services/transport");

    if (transport === undefined) {
      throw new Error("Expected transport node.");
    }

    const result = await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [transport.nodeId],
        mode: "selfAndDependents",
        reason: "test eviction",
      })
    );
    const tagByNodeId = new Map(wired.nodes.map((node) => [node.nodeId, node.tag]));
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(result.nodeIds).toHaveLength(2);
    expect(result.nodeIds.map((nodeId) => tagByNodeId.get(nodeId))).toEqual([
      "services/transport",
      "resources/profile",
    ]);
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
  });

  test("dependents eviction mode keeps the root dependency wired", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ProfileNode, args: {} }));
    const wired = await Effect.runPromise(graph.snapshot());
    const transport = wired.nodes.find((node) => node.tag === "services/transport");

    if (transport === undefined) {
      throw new Error("Expected transport node.");
    }

    const result = await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [transport.nodeId],
        mode: "dependents",
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(result.nodeIds).toHaveLength(1);
    expect(snapshot.nodes.map((node) => node.tag)).toEqual(["services/transport"]);
    expect(snapshot.edges).toEqual([]);
  });

  test("eviction interrupts active acquire and removes the graph record", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    type HangingSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class HangingNode extends NodeBase<HangingSpec> {
      static readonly spec = serviceSpec<HangingSpec>({
        tag: "services/evict-hanging",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<HangingSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const ready = Effect.runPromise(graph.ensureReadyNode({ spec: HangingNode, args: {} })).catch(
      (cause) => cause
    );

    await Effect.runPromise(Deferred.await(started));

    const wired = await Effect.runPromise(graph.snapshot());
    const hanging = wired.nodes.find((node) => node.tag === "services/evict-hanging");

    if (hanging === undefined) {
      throw new Error("Expected hanging node.");
    }

    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [hanging.nodeId],
        mode: "selfAndDependents",
      })
    );

    const interrupted = await ready;
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(interrupted).toBeDefined();
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
  });

  test("eviction mid-acquire aborts the driver signal and drains registered disposers", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    let acquireSignal: AbortSignal | undefined;
    let lateDisposers: ((disposer: () => void) => void) | undefined;
    let disposerRuns = 0;
    let lateDisposerRuns = 0;
    type InterruptedAcquireSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class InterruptedAcquireNode extends NodeBase<InterruptedAcquireSpec> {
      static readonly spec = serviceSpec<InterruptedAcquireSpec>({
        tag: "services/evict-interrupted-acquire",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<InterruptedAcquireSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.gen(function* () {
              acquireSignal = ctx.signal;
              lateDisposers = (disposer) => ctx.disposers.add(disposer);
              ctx.disposers.add(() => {
                disposerRuns += 1;
              });
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const ready = Effect.runPromise(
      graph.ensureReadyNode({ spec: InterruptedAcquireNode, args: {} })
    ).catch((cause) => cause);

    await Effect.runPromise(Deferred.await(started));

    const wired = await Effect.runPromise(graph.snapshot());
    const pending = wired.nodes.find((node) => node.tag === "services/evict-interrupted-acquire");

    if (pending === undefined) {
      throw new Error("Expected interrupted acquire node.");
    }

    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [pending.nodeId],
        mode: "selfAndDependents",
      })
    );
    await ready;

    expect(acquireSignal?.aborted).toBe(true);
    expect(disposerRuns).toBe(1);

    // A late registration on the settled operation runs immediately instead of
    // landing in a drained array nobody reads.
    lateDisposers?.(() => {
      lateDisposerRuns += 1;
    });
    expect(lateDisposerRuns).toBe(1);
  });

  test("eviction mid-refresh aborts the driver signal and drains refresh disposers", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    let refreshSignal: AbortSignal | undefined;
    let refreshDisposerRuns = 0;
    type InterruptedRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class InterruptedRefreshNode extends NodeBase<InterruptedRefreshSpec> {
      static readonly spec = serviceSpec<InterruptedRefreshSpec>({
        tag: "services/evict-interrupted-refresh",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<InterruptedRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              refreshSignal = ctx.signal;
              ctx.disposers.add(() => {
                refreshDisposerRuns += 1;
              });
              yield* Deferred.succeed(refreshStarted, undefined);
              return yield* Effect.never;
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: InterruptedRefreshNode, args: {} })
    );
    const refresh = Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: InterruptedRefreshNode, args: {} } },
      })
    );

    await Effect.runPromise(Deferred.await(refreshStarted));
    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [handle.nodeId],
        mode: "selfAndDependents",
        reason: "refresh interrupted",
      })
    );
    const result = await refresh;

    expect(result._tag).toBe("Failure");
    expect(refreshSignal?.aborted).toBe(true);
    expect(refreshDisposerRuns).toBe(1);
  });

  test("eviction mid-action aborts the driver signal and drains action disposers", async () => {
    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    let actionSignal: AbortSignal | undefined;
    let actionDisposerRuns = 0;
    type InterruptedActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
      readonly actions: {
        readonly block: ActionContract<void, void>;
      };
    }>;

    class InterruptedActionNode extends NodeBase<InterruptedActionSpec> {
      static readonly spec = serviceSpec<InterruptedActionSpec>({
        tag: "services/evict-interrupted-action",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<InterruptedActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          actions: {
            block: Driver.Action((ctx) =>
              Effect.gen(function* () {
                actionSignal = ctx.signal;
                ctx.disposers.add(() => {
                  actionDisposerRuns += 1;
                });
                yield* Deferred.succeed(actionStarted, undefined);
                return yield* Effect.never;
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: InterruptedActionNode, args: {} })
    );
    const action = Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeRequest", request: { spec: InterruptedActionNode, args: {} } },
        action: "block",
        input: undefined,
      })
    );

    await Effect.runPromise(Deferred.await(actionStarted));
    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [handle.nodeId],
        mode: "selfAndDependents",
        reason: "action interrupted",
      })
    );
    const result = await action;

    expect(result._tag).toBe("Failure");
    expect(actionSignal?.aborted).toBe(true);
    expect(actionDisposerRuns).toBe(1);
  });

  test("eviction during pending refresh returns failure and does not commit late result", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    type RefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class RefreshNode extends NodeBase<RefreshSpec> {
      static readonly spec = serviceSpec<RefreshSpec>({
        tag: "services/evict-refresh",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({ value: "late" });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: RefreshNode, args: {} }));
    const refresh = Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: RefreshNode, args: {} } },
      })
    );

    await Effect.runPromise(Deferred.await(refreshStarted));
    const pendingSnapshot = await Effect.runPromise(graph.snapshot());
    const pending = pendingSnapshot.nodes.find((node) => node.tag === "services/evict-refresh");

    expect(pending?.result).toEqual({ value: "stable" });
    expect(pending?.operation).toMatchObject({ _tag: "Running", kind: "refresh" });

    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [pending?.nodeId ?? ("" as never)],
        mode: "selfAndDependents",
        reason: "refresh evicted",
      })
    );
    const result = await refresh;

    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.error.cause : undefined).toBeInstanceOf(NodeEvicted);
    expect(result._tag === "Failure" ? result.error.cause : undefined).toMatchObject({
      cancellation: { _tag: "Evicted", detail: "refresh evicted" },
      reason: "refresh evicted",
    });
    expect(snapshot.nodes).toEqual([]);
  });

  test("eviction during pending action returns failure and does not commit late result", async () => {
    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    const actionGate = await Effect.runPromise(Deferred.make<void>());
    type ActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
      readonly actions: {
        readonly setValue: ActionContract<void, void>;
      };
    }>;

    class ActionNode extends NodeBase<ActionSpec> {
      static readonly spec = serviceSpec<ActionSpec>({
        tag: "services/evict-action",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          actions: {
            setValue: Driver.Action((ctx) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(actionStarted, undefined);
                yield* Deferred.await(actionGate);
                yield* ctx.setResult({ value: "late" });
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ActionNode, args: {} }));
    const action = Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeRequest", request: { spec: ActionNode, args: {} } },
        action: "setValue",
        input: undefined,
      })
    );

    await Effect.runPromise(Deferred.await(actionStarted));
    const pendingSnapshot = await Effect.runPromise(graph.snapshot());
    const pending = pendingSnapshot.nodes.find((node) => node.tag === "services/evict-action");

    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [pending?.nodeId ?? ("" as never)],
        mode: "selfAndDependents",
        reason: "action evicted",
      })
    );
    const result = await action;

    await Effect.runPromise(Deferred.succeed(actionGate, undefined));
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.error.cause : undefined).toBeInstanceOf(NodeEvicted);
    expect(result._tag === "Failure" ? result.error.cause : undefined).toMatchObject({
      cancellation: { _tag: "Evicted", detail: "action evicted" },
      reason: "action evicted",
    });
    expect(snapshot.nodes).toEqual([]);
  });

  test("eviction during pending args update returns failure and does not commit late args", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    type ArgsSpec = NodeSpec<{
      readonly args: { readonly page: number };
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly page: number };
    }>;

    class ArgsNode extends NodeBase<ArgsSpec> {
      static readonly spec = serviceSpec<ArgsSpec>({
        tag: "services/evict-args",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ArgsSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ page: 1 })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({
                page: ctx.args.page,
              });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ArgsNode, args: { page: 1 } })
    );

    const update = Effect.runPromise(
      graph.updateNodeArgs({
        nodeId: handle.nodeId,
        spec: ArgsNode,
        args: { page: 2 },
      })
    );

    await Effect.runPromise(Deferred.await(refreshStarted));
    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [handle.nodeId],
        mode: "selfAndDependents",
        reason: "args evicted",
      })
    );
    const result = await update;

    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.error.cause : undefined).toBeInstanceOf(NodeEvicted);
    expect(result._tag === "Failure" ? result.error.cause : undefined).toMatchObject({
      cancellation: { _tag: "Evicted", detail: "args evicted" },
      reason: "args evicted",
    });
    expect(snapshot.nodes).toEqual([]);
  });

  test("eviction during dependency readiness does not leave orphan dependency work", async () => {
    const childStarted = await Effect.runPromise(Deferred.make<void>());
    const childGate = await Effect.runPromise(Deferred.make<string>());
    let childAttempts = 0;

    type EvictedDependencySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class EvictedDependencyNode extends NodeBase<EvictedDependencySpec> {
      static readonly spec = serviceSpec<EvictedDependencySpec>({
        tag: "services/evict-dependency-child",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<EvictedDependencySpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              childAttempts += 1;
              yield* Deferred.succeed(childStarted, undefined);
              return yield* Deferred.await(childGate);
            })
          ),
        }),
      });
    }

    type EvictedDependencyRootSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly child: Dep<typeof EvictedDependencyNode>;
      };
      readonly result: string;
    }>;

    class EvictedDependencyRoot extends NodeBase<EvictedDependencyRootSpec> {
      static readonly spec = resourceSpec<EvictedDependencyRootSpec>({
        tag: "resources/evict-dependency-root",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ child: dep(EvictedDependencyNode, {}) })),
        driver: Driver.Effect<EvictedDependencyRootSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("root")),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    const ready = Effect.runPromise(
      graph.ensureReadyNode({ spec: EvictedDependencyRoot, args: {} })
    );

    await Effect.runPromise(Deferred.await(childStarted));

    const pending = await Effect.runPromise(graph.snapshot());
    const child = pending.nodes.find((node) => node.tag === "services/evict-dependency-child");

    if (child === undefined) {
      throw new Error("Expected dependency node.");
    }

    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [child.nodeId],
        mode: "selfAndDependents",
        reason: "dependency evicted",
      })
    );

    const result = await ready;
    await Effect.runPromise(Deferred.succeed(childGate, "late"));
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(childAttempts).toBe(1);
    expect(result.status).toMatchObject({ _tag: "Wired", run: { _tag: "Error" } });
    expect(snapshot.nodes).toEqual([]);
  });

  test("double eviction and missing eviction are idempotent", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ProfileNode, args: {} }));
    const wired = await Effect.runPromise(graph.snapshot());
    const profile = wired.nodes.find((node) => node.tag === "resources/profile");

    if (profile === undefined) {
      throw new Error("Expected profile node.");
    }

    const first = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [profile.nodeId], mode: "selfAndDependents" })
    );
    const second = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [profile.nodeId], mode: "selfAndDependents" })
    );
    const missing = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: ["missing" as never], mode: "selfAndDependents" })
    );

    expect(first.nodeIds).toHaveLength(1);
    expect(second).toEqual({ nodeIds: [], failures: [] });
    expect(missing).toEqual({ nodeIds: [], failures: [] });
  });

  test("invalid planned nodes can be evicted", async () => {
    type InvalidKeySpec = NodeSpec<{
      readonly args: { readonly value: number };
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class InvalidKeyNode extends NodeBase<InvalidKeySpec> {
      static readonly spec = serviceSpec<InvalidKeySpec>({
        tag: "services/evict-invalid",
        key: (args) => ({ value: args.value }) as never,
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<InvalidKeySpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureNode({ spec: InvalidKeyNode, args: { value: NaN } })
    );

    const result = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(handle.status._tag).toBe("Invalid");
    expect(result.nodeIds).toEqual([handle.nodeId]);
    expect(snapshot.nodes).toEqual([]);
  });

  test("orders evicted nodes by dependency depth in a chain", async () => {
    type DepthLeafSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;
    class DepthLeafNode extends NodeBase<DepthLeafSpec> {
      static readonly spec = serviceSpec<DepthLeafSpec>({
        tag: "services/depth-leaf",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DepthLeafSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("leaf")),
        }),
      });
    }
    type DepthMidSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: { readonly leaf: Dep<typeof DepthLeafNode> };
      readonly result: string;
    }>;
    class DepthMidNode extends NodeBase<DepthMidSpec> {
      static readonly spec = resourceSpec<DepthMidSpec>({
        tag: "resources/depth-mid",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ leaf: dep(DepthLeafNode, {}) })),
        driver: Driver.Effect<DepthMidSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed(`mid:${ctx.deps.leaf.result}`)),
        }),
      });
    }
    type DepthTopSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: { readonly mid: Dep<typeof DepthMidNode> };
      readonly result: string;
    }>;
    class DepthTopNode extends NodeBase<DepthTopSpec> {
      static readonly spec = resourceSpec<DepthTopSpec>({
        tag: "resources/depth-top",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ mid: dep(DepthMidNode, {}) })),
        driver: Driver.Effect<DepthTopSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed(`top:${ctx.deps.mid.result}`)),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(graph.ensureReadyNode({ spec: DepthTopNode, args: {} }));
    const wired = await Effect.runPromise(graph.snapshot());
    const tagByNodeId = new Map(wired.nodes.map((node) => [node.nodeId, node.tag]));
    const leaf = wired.nodes.find((node) => node.tag === "services/depth-leaf");

    if (leaf === undefined) {
      throw new Error("Expected leaf node.");
    }

    const result = await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [leaf.nodeId],
        mode: "selfAndDependents",
        reason: "depth ordering",
      })
    );

    // Deepest dependency first (leaf reaches the most dependents), then its
    // dependents in decreasing depth. Unambiguous in a chain (no ties).
    expect(result.nodeIds.map((nodeId) => tagByNodeId.get(nodeId))).toEqual([
      "services/depth-leaf",
      "resources/depth-mid",
      "resources/depth-top",
    ]);
  });

  test("orders a diamond subgraph by dependency depth", async () => {
    type DiamondLeafSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;
    class DiamondLeafNode extends NodeBase<DiamondLeafSpec> {
      static readonly spec = serviceSpec<DiamondLeafSpec>({
        tag: "services/diamond-leaf",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DiamondLeafSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("leaf")),
        }),
      });
    }
    type DiamondSideSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: { readonly leaf: Dep<typeof DiamondLeafNode> };
      readonly result: string;
    }>;
    const diamondSide = (tag: string) =>
      class extends NodeBase<DiamondSideSpec> {
        static readonly spec = resourceSpec<DiamondSideSpec>({
          tag,
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({ leaf: dep(DiamondLeafNode, {}) })),
          driver: Driver.Effect<DiamondSideSpec>({
            acquire: Driver.Acquire((ctx) => Effect.succeed(`${tag}:${ctx.deps.leaf.result}`)),
          }),
        });
      };
    const DiamondLeftNode = diamondSide("resources/diamond-left");
    const DiamondRightNode = diamondSide("resources/diamond-right");
    type DiamondTopSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly left: Dep<typeof DiamondLeftNode>;
        readonly right: Dep<typeof DiamondRightNode>;
      };
      readonly result: string;
    }>;
    class DiamondTopNode extends NodeBase<DiamondTopSpec> {
      static readonly spec = resourceSpec<DiamondTopSpec>({
        tag: "resources/diamond-top",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          left: dep(DiamondLeftNode, {}),
          right: dep(DiamondRightNode, {}),
        })),
        driver: Driver.Effect<DiamondTopSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed(`top:${ctx.deps.left.result}:${ctx.deps.right.result}`)
          ),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(graph.ensureReadyNode({ spec: DiamondTopNode, args: {} }));
    const wired = await Effect.runPromise(graph.snapshot());
    const tagByNodeId = new Map(wired.nodes.map((node) => [node.nodeId, node.tag]));
    const leaf = wired.nodes.find((node) => node.tag === "services/diamond-leaf");

    if (leaf === undefined) {
      throw new Error("Expected diamond leaf node.");
    }

    const result = await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [leaf.nodeId],
        mode: "selfAndDependents",
        reason: "diamond depth",
      })
    );
    const orderedTags = result.nodeIds.map((nodeId) => tagByNodeId.get(nodeId));

    // Depth-monotonic: the shared leaf (deepest) first, the join node (shallowest)
    // last, with the two equal-depth sides in between.
    expect(orderedTags).toHaveLength(4);
    expect(orderedTags[0]).toBe("services/diamond-leaf");
    expect(orderedTags[3]).toBe("resources/diamond-top");
    expect(new Set(orderedTags.slice(1, 3))).toEqual(
      new Set(["resources/diamond-left", "resources/diamond-right"])
    );
  });

  test("release timeout during eviction returns cleanup failure and removes graph records", async () => {
    type HangingReleaseSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class HangingReleaseNode extends NodeBase<HangingReleaseSpec> {
      static readonly spec = serviceSpec<HangingReleaseSpec>({
        tag: "services/evict-hanging-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<HangingReleaseSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() => Effect.never),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: HangingReleaseNode, args: {} })
    );

    const result = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(result.nodeIds).toEqual([handle.nodeId]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBeInstanceOf(DisposerFailed);
    expect(snapshot.nodes).toEqual([]);
  });
});
