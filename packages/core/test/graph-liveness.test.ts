import { describe, expect, test } from "bun:test";
import type { ActiveNodeLiveDemandSnapshot, NodeId, NodeLiveDemandSnapshot } from "../src/graph";
import { makeResultObservedReporter } from "../src/graph/liveness/resultObservationBridge";
import {
  type ActionContract,
  Driver,
  DriverOperationTimedOut,
  dependencies,
  Effect,
  EffectBoundaryFailed,
  GraphInvariantViolation,
  Key,
  LiveDeliveryFailed,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  ProfileNode,
  resourceSpec,
} from "./graphTestFixtures";

describe("graph liveness", () => {
  test("result observation bridge reports rejected work and keeps the queue alive", async () => {
    const nodeId = "node:result-observation" as NodeId;
    const tag = "graph/resources/result-observation";
    const cause = new Error("observation failed");
    const observedScopes: Array<unknown> = [];
    const failures: Array<unknown> = [];
    const reporter = makeResultObservedReporter(
      {
        reportResultObserved: async (_nodeId, scope) => {
          observedScopes.push(scope);

          if (scope === "first") {
            throw cause;
          }

          return { _tag: "Missing" } as const;
        },
        notifyLiveFailures: (_nodeId, graphFailures) =>
          Effect.sync(() => {
            failures.push(...graphFailures);
          }),
      },
      { nodeId, tag }
    );

    reporter("first", true);
    reporter("second", true);

    for (let attempt = 0; attempt < 10 && observedScopes.length < 2; attempt += 1) {
      await Promise.resolve();
    }

    expect(observedScopes).toEqual(["first", "second"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(GraphInvariantViolation);
    expect(failures[0]).toMatchObject({
      nodeId,
      tag,
      invariant: "result observation reporting failed",
      cause,
    });
  });

  test("result observation bridge recovers when live failure notification fails", async () => {
    const nodeId = "node:result-observation-notify" as NodeId;
    const observedScopes: Array<unknown> = [];
    const reporter = makeResultObservedReporter(
      {
        reportResultObserved: async (_nodeId, scope) => {
          observedScopes.push(scope);

          if (scope === "first") {
            throw new Error("observation failed");
          }

          return { _tag: "Missing" } as const;
        },
        notifyLiveFailures: () => Effect.fail(new Error("notification failed")),
      },
      { nodeId, tag: "graph/resources/result-observation-notify" }
    );

    reporter("first", true);
    reporter("second", true);

    for (let attempt = 0; attempt < 10 && observedScopes.length < 2; attempt += 1) {
      await Promise.resolve();
    }

    expect(observedScopes).toEqual(["first", "second"]);
  });

  test("graph observers unsubscribe independently and remain best-effort", async () => {
    type ObservableSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
      readonly actions: {
        readonly setValidity: ActionContract<
          { readonly _tag: "Current" } | { readonly _tag: "Stale"; readonly staleAt: number },
          void
        >;
      };
    }>;

    class ObservableNode extends NodeBase<ObservableSpec> {
      static readonly spec = resourceSpec<ObservableSpec>({
        tag: "graph/resources/observer-channel",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ObservableSpec>({
          resultValidity: { _tag: "Manual" },
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          actions: {
            setValidity: Driver.Action((ctx, input) => ctx.setResultValidity(input)),
          },
          live: Driver.Live({
            start: () => Effect.fail(new Error("live observer channel failure")),
            stop: () => Effect.void,
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const counts = {
      node: 0,
      validity: 0,
      liveDemand: 0,
      liveFailures: 0,
      operationStarts: 0,
    };
    const observerFailures: Array<string> = [];
    const increment = (field: keyof typeof counts) =>
      Effect.sync(() => {
        counts[field] += 1;
      });
    const nodeSubscription = await Effect.runPromise(
      graph.observeNodeChanges(() => increment("node"))
    );
    const validitySubscription = await Effect.runPromise(
      graph.observeResultValidityChanges(() => increment("validity"))
    );
    const liveDemandSubscription = await Effect.runPromise(
      graph.observeLiveDemandChanges(() => increment("liveDemand"))
    );
    const liveFailuresSubscription = await Effect.runPromise(
      graph.observeLiveFailures(() => increment("liveFailures"))
    );
    const operationStartSubscription = await Effect.runPromise(
      graph.observeOperationStarts(() => increment("operationStarts"))
    );
    await Effect.runPromise(
      graph.observeObserverFailures((failure) =>
        Effect.sync(() => {
          observerFailures.push(failure.channel);
        })
      )
    );

    await Effect.runPromise(
      graph.observeNodeChanges(() => Effect.fail(new Error("node observer")))
    );
    await Effect.runPromise(
      graph.observeResultValidityChanges(() => Effect.fail(new Error("validity observer")))
    );
    await Effect.runPromise(
      graph.observeLiveDemandChanges(() => Effect.fail(new Error("demand observer")))
    );
    await Effect.runPromise(
      graph.observeLiveFailures(() => Effect.fail(new Error("failure observer")))
    );
    await Effect.runPromise(
      graph.observeOperationStarts(() => Effect.fail(new Error("operation observer")))
    );

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ObservableNode, args: {} })
    );
    const nodeCount = counts.node;

    nodeSubscription.unsubscribe();
    await Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeId", nodeId: handle.nodeId },
        action: "setValidity",
        input: { _tag: "Stale", staleAt: 1 },
      })
    );

    expect(counts.node).toBe(nodeCount);
    expect(counts.operationStarts).toBe(1);
    expect(counts.validity).toBe(1);

    validitySubscription.unsubscribe();
    await Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeId", nodeId: handle.nodeId },
        action: "setValidity",
        input: { _tag: "Current" },
      })
    );

    expect(counts.validity).toBe(1);

    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    expect(counts.liveDemand).toBe(1);
    expect(counts.liveFailures).toBe(1);

    liveDemandSubscription.unsubscribe();
    liveFailuresSubscription.unsubscribe();
    operationStartSubscription.unsubscribe();
    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: lease.leaseId,
      })
    );
    await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "ETH/USD" },
      })
    );

    expect(counts.liveDemand).toBe(1);
    expect(counts.liveFailures).toBe(1);
    expect(observerFailures).toContain("node-change");
    expect(observerFailures).toContain("result-validity");
    expect(observerFailures).toContain("live-demand");
    expect(observerFailures).toContain("live-failure");
    expect(observerFailures).toContain("operation-start");
  });

  test("live leases derive scoped demand without lifecycle side effects", async () => {
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(graph.ensureNode({ spec: ProfileNode, args: {} }));

    const first = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const second = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "mobx",
        scope: { pair: "BTC/USD" },
      })
    );
    const third = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "ETH/USD" },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.nodeId === handle.nodeId);

    expect(first.liveDemand).toEqual({
      isLive: true,
      sources: ["manual"],
      scopes: [{ pair: "BTC/USD" }],
    });
    expect(second.liveDemand).toEqual({
      isLive: true,
      sources: ["manual", "mobx"],
      scopes: [{ pair: "BTC/USD" }],
    });
    expect(third.liveDemand).toEqual({
      isLive: true,
      sources: ["manual", "mobx"],
      scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
    });
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.liveDemand).toEqual(third.liveDemand);
  });

  test("live leases are reference counted by lease identity", async () => {
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(graph.ensureNode({ spec: ProfileNode, args: {} }));
    const first = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const second = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    const afterFirstRelease = await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: first.leaseId,
      })
    );
    const afterSecondRelease = await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: second.leaseId,
      })
    );
    const secondReleaseAgain = await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: second.leaseId,
      })
    );

    expect(afterFirstRelease.liveDemand).toEqual({
      isLive: true,
      sources: ["manual"],
      scopes: [{ pair: "BTC/USD" }],
    });
    expect(afterFirstRelease.changed).toBe(false);
    expect(afterSecondRelease.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
    expect(afterSecondRelease.changed).toBe(true);
    expect(secondReleaseAgain.changed).toBe(false);
  });

  test("live demand acquired before readiness is delivered once after readiness", async () => {
    const deliveries: Array<NodeLiveDemandSnapshot> = [];
    const cleanups: Array<string> = [];
    type PreReadyLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class PreReadyLiveNode extends NodeBase<PreReadyLiveSpec> {
      static readonly spec = resourceSpec<PreReadyLiveSpec>({
        tag: "graph/resources/pre-ready-live",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<PreReadyLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (_ctx, demand) =>
              Effect.sync(() => {
                deliveries.push(demand);
                return "live";
              }),
            stop: (_ctx, resource) =>
              Effect.sync(() => {
                cleanups.push(resource);
              }),
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(graph.ensureNode({ spec: PreReadyLiveNode, args: {} }));

    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    expect(lease.liveDemand).toEqual({
      isLive: true,
      sources: ["manual"],
      scopes: [{ pair: "BTC/USD" }],
    });
    expect(deliveries).toEqual([]);

    await Effect.runPromise(graph.ensureReadyNode({ spec: PreReadyLiveNode, args: {} }));

    expect(deliveries).toEqual([
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "BTC/USD" }],
      },
    ]);
    expect(cleanups).toEqual([]);

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: lease.leaseId,
      })
    );

    expect(cleanups).toEqual(["live"]);
  });

  test("live start failure after pre-ready demand is reported when readiness succeeds", async () => {
    const failure = new Error("live unavailable after readiness");
    const observedFailures: Array<unknown> = [];
    type PreReadyFailingLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class PreReadyFailingLiveNode extends NodeBase<PreReadyFailingLiveSpec> {
      static readonly spec = resourceSpec<PreReadyFailingLiveSpec>({
        tag: "graph/resources/pre-ready-failing-live",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<PreReadyFailingLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.fail(failure),
            stop: () => Effect.void,
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(
      graph.observeLiveFailures((_nodeId, failures) =>
        Effect.sync(() => {
          observedFailures.push(...failures);
        })
      )
    );
    const handle = await Effect.runPromise(
      graph.ensureNode({ spec: PreReadyFailingLiveNode, args: {} })
    );

    await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    const ready = await Effect.runPromise(
      graph.ensureReadyNode({ spec: PreReadyFailingLiveNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.nodeId === handle.nodeId);

    expect(ready._tag).toBe("Ready");
    expect(observedFailures).toHaveLength(1);
    expect(observedFailures[0]).toBeInstanceOf(LiveDeliveryFailed);
    const observedFailure = observedFailures[0];
    expect(observedFailure instanceof LiveDeliveryFailed ? observedFailure.stage : undefined).toBe(
      "start"
    );
    expect(observedFailure instanceof LiveDeliveryFailed ? observedFailure.cause : undefined).toBe(
      failure
    );
    expect(node?.liveFailure?.failures).toHaveLength(1);
  });

  test("equivalent active live demand does not restart driver live delivery", async () => {
    const deliveries: Array<NodeLiveDemandSnapshot> = [];
    const cleanups: Array<string> = [];
    type StableLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class StableLiveNode extends NodeBase<StableLiveSpec> {
      static readonly spec = resourceSpec<StableLiveSpec>({
        tag: "graph/resources/stable-live-demand",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<StableLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (_ctx, demand) =>
              Effect.sync(() => {
                deliveries.push(demand);
                return "live";
              }),
            stop: (_ctx, resource) =>
              Effect.sync(() => {
                cleanups.push(resource);
              }),
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: StableLiveNode, args: {} })
    );

    const first = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const second = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(deliveries).toHaveLength(1);
    expect(cleanups).toEqual([]);

    const afterFirstRelease = await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: first.leaseId,
      })
    );

    expect(afterFirstRelease.changed).toBe(false);
    expect(deliveries).toHaveLength(1);
    expect(cleanups).toEqual([]);

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: second.leaseId,
      })
    );

    expect(deliveries).toHaveLength(1);
    expect(cleanups).toEqual(["live"]);
  });

  test("changed active live demand without update stops previous resource and starts the next", async () => {
    const deliveries: Array<{ readonly runId: number; readonly demand: NodeLiveDemandSnapshot }> =
      [];
    const cleanups: Array<number> = [];
    type RestartingLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class RestartingLiveNode extends NodeBase<RestartingLiveSpec> {
      static readonly spec = resourceSpec<RestartingLiveSpec>({
        tag: "graph/resources/restarting-live-demand",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RestartingLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (_ctx, demand) =>
              Effect.sync(() => {
                const runId = deliveries.length + 1;
                deliveries.push({ runId, demand });
                return runId;
              }),
            stop: (_ctx, runId) =>
              Effect.sync(() => {
                cleanups.push(runId);
              }),
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: RestartingLiveNode, args: {} })
    );

    const btc = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const eth = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "ETH/USD" },
      })
    );

    expect(deliveries).toEqual([
      {
        runId: 1,
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "BTC/USD" }],
        },
      },
      {
        runId: 2,
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
        },
      },
    ]);
    expect(cleanups).toEqual([1]);

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: btc.leaseId,
      })
    );

    expect(deliveries).toEqual([
      {
        runId: 1,
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "BTC/USD" }],
        },
      },
      {
        runId: 2,
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
        },
      },
      {
        runId: 3,
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "ETH/USD" }],
        },
      },
    ]);
    expect(cleanups).toEqual([1, 2]);

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: eth.leaseId,
      })
    );

    expect(deliveries).toHaveLength(3);
    expect(cleanups).toEqual([1, 2, 3]);
  });

  test("changed active live demand updates existing resource when update is provided", async () => {
    type LiveResourceRecord = {
      current: ActiveNodeLiveDemandSnapshot;
      readonly id: number;
    };

    const starts: Array<NodeLiveDemandSnapshot> = [];
    const updates: Array<NodeLiveDemandSnapshot> = [];
    const stops: Array<{
      readonly id: number;
      readonly reason: string;
      readonly demand: NodeLiveDemandSnapshot;
    }> = [];
    type UpdatingLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class UpdatingLiveNode extends NodeBase<UpdatingLiveSpec> {
      static readonly spec = resourceSpec<UpdatingLiveSpec>({
        tag: "graph/resources/updating-live-demand",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<UpdatingLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (_ctx, demand) =>
              Effect.sync(() => {
                starts.push(demand);
                return { id: starts.length, current: demand } satisfies LiveResourceRecord;
              }),
            update: (_ctx, resource, demand) =>
              Effect.sync(() => {
                updates.push(demand);
                resource.current = demand;
              }),
            stop: (ctx, resource) =>
              Effect.sync(() => {
                stops.push({
                  id: resource.id,
                  reason: ctx.reason._tag,
                  demand: resource.current,
                });
              }),
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: UpdatingLiveNode, args: {} })
    );

    const btc = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const eth = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "ETH/USD" },
      })
    );

    expect(starts).toEqual([
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "BTC/USD" }],
      },
    ]);
    expect(updates).toEqual([
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
      },
    ]);
    expect(stops).toEqual([]);

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: btc.leaseId,
      })
    );

    expect(starts).toHaveLength(1);
    expect(updates).toEqual([
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
      },
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "ETH/USD" }],
      },
    ]);
    expect(stops).toEqual([]);

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: eth.leaseId,
      })
    );

    expect(starts).toHaveLength(1);
    expect(stops).toEqual([
      {
        id: 1,
        reason: "DemandInactive",
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "ETH/USD" }],
        },
      },
    ]);
  });

  test("live update failure reports stops and starts once with latest active demand", async () => {
    type LiveResourceRecord = {
      readonly id: number;
      readonly demand: ActiveNodeLiveDemandSnapshot;
    };

    const cause = new Error("resubscribe failed");
    const starts: Array<LiveResourceRecord> = [];
    const updates: Array<NodeLiveDemandSnapshot> = [];
    const stops: Array<{ readonly id: number; readonly reason: string }> = [];
    type UpdatingFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class UpdatingFailureNode extends NodeBase<UpdatingFailureSpec> {
      static readonly spec = resourceSpec<UpdatingFailureSpec>({
        tag: "graph/resources/update-failure-live-demand",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<UpdatingFailureSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (_ctx, demand) =>
              Effect.sync(() => {
                const resource = { id: starts.length + 1, demand } satisfies LiveResourceRecord;
                starts.push(resource);
                return resource;
              }),
            update: (_ctx, _resource, demand) =>
              Effect.sync(() => {
                updates.push(demand);
              }).pipe(Effect.andThen(Effect.fail(cause))),
            stop: (ctx, resource) =>
              Effect.sync(() => {
                stops.push({ id: resource.id, reason: ctx.reason._tag });
              }),
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: UpdatingFailureNode, args: {} })
    );

    const first = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const second = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "ETH/USD" },
      })
    );

    expect(first.failures).toEqual([]);
    expect(second.failures).toHaveLength(1);
    expect(second.failures[0]).toMatchObject({
      _tag: "LiveDeliveryFailed",
      stage: "update",
      cause,
    });
    expect(updates).toEqual([
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
      },
    ]);
    expect(stops).toEqual([{ id: 1, reason: "UpdateFailed" }]);
    expect(starts).toEqual([
      {
        id: 1,
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "BTC/USD" }],
        },
      },
      {
        id: 2,
        demand: {
          isLive: true,
          sources: ["manual"],
          scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
        },
      },
    ]);

    await Effect.runPromise(graph.stop());

    expect(stops).toEqual([
      { id: 1, reason: "UpdateFailed" },
      { id: 2, reason: "GraphStopped" },
    ]);
  });

  test("live start update and stop timeouts surface typed live failures", async () => {
    type StartTimeoutSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class StartTimeoutNode extends NodeBase<StartTimeoutSpec> {
      static readonly spec = resourceSpec<StartTimeoutSpec>({
        tag: "graph/resources/live-start-timeout",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<StartTimeoutSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.never,
            stop: () => Effect.void,
          }),
        }),
      });
    }
    const startGraph = makeInMemoryGraphSystem({
      runtimeId: "mock-test-runtime",
      driverTimeouts: { live: 5 },
    });
    const startHandle = await Effect.runPromise(
      startGraph.ensureReadyNode({ spec: StartTimeoutNode, args: {} })
    );
    const startLease = await Effect.runPromise(
      startGraph
        .acquireNodeLiveLease({
          nodeId: startHandle.nodeId,
          source: "manual",
          scope: { pair: "BTC/USD" },
        })
        .pipe(Effect.timeout("200 millis"))
    );
    const startFailure = startLease.failures[0];

    expect(startFailure).toBeInstanceOf(LiveDeliveryFailed);
    expect(startFailure).toMatchObject({ _tag: "LiveDeliveryFailed", stage: "start" });
    expect(
      startFailure instanceof LiveDeliveryFailed ? startFailure.cause : undefined
    ).toBeInstanceOf(DriverOperationTimedOut);
    expect(
      startFailure instanceof LiveDeliveryFailed &&
        startFailure.cause instanceof DriverOperationTimedOut
        ? startFailure.cause.operation
        : undefined
    ).toBe("live.start");

    const updateStops: Array<string> = [];
    type UpdateTimeoutSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class UpdateTimeoutNode extends NodeBase<UpdateTimeoutSpec> {
      static readonly spec = resourceSpec<UpdateTimeoutSpec>({
        tag: "graph/resources/live-update-timeout",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<UpdateTimeoutSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (_ctx, demand) =>
              Effect.succeed({
                demand,
                id: updateStops.length + 1,
              }),
            update: () => Effect.never,
            stop: (ctx) =>
              Effect.sync(() => {
                updateStops.push(ctx.reason._tag);
              }),
          }),
        }),
      });
    }
    const updateGraph = makeInMemoryGraphSystem({
      runtimeId: "mock-test-runtime",
      driverTimeouts: { live: 5 },
    });
    const updateHandle = await Effect.runPromise(
      updateGraph.ensureReadyNode({ spec: UpdateTimeoutNode, args: {} })
    );
    await Effect.runPromise(
      updateGraph.acquireNodeLiveLease({
        nodeId: updateHandle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const updateLease = await Effect.runPromise(
      updateGraph
        .acquireNodeLiveLease({
          nodeId: updateHandle.nodeId,
          source: "manual",
          scope: { pair: "ETH/USD" },
        })
        .pipe(Effect.timeout("200 millis"))
    );
    const updateFailure = updateLease.failures[0];

    expect(updateFailure).toBeInstanceOf(LiveDeliveryFailed);
    expect(updateFailure).toMatchObject({ _tag: "LiveDeliveryFailed", stage: "update" });
    expect(
      updateFailure instanceof LiveDeliveryFailed ? updateFailure.cause : undefined
    ).toBeInstanceOf(DriverOperationTimedOut);
    expect(
      updateFailure instanceof LiveDeliveryFailed &&
        updateFailure.cause instanceof DriverOperationTimedOut
        ? updateFailure.cause.operation
        : undefined
    ).toBe("live.update");
    expect(updateStops).toEqual(["UpdateFailed"]);

    type StopTimeoutSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class StopTimeoutNode extends NodeBase<StopTimeoutSpec> {
      static readonly spec = resourceSpec<StopTimeoutSpec>({
        tag: "graph/resources/live-stop-timeout",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<StopTimeoutSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.succeed("live"),
            stop: () => Effect.never,
          }),
        }),
      });
    }
    const stopGraph = makeInMemoryGraphSystem({
      runtimeId: "mock-test-runtime",
      driverTimeouts: { live: 5 },
    });
    const stopHandle = await Effect.runPromise(
      stopGraph.ensureReadyNode({ spec: StopTimeoutNode, args: {} })
    );
    const stopLease = await Effect.runPromise(
      stopGraph.acquireNodeLiveLease({
        nodeId: stopHandle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const stopResult = await Effect.runPromise(
      stopGraph
        .releaseNodeLiveLease({
          nodeId: stopHandle.nodeId,
          leaseId: stopLease.leaseId,
        })
        .pipe(Effect.timeout("200 millis"))
    );
    const stopFailure = stopResult.failures[0];

    expect(stopFailure).toBeInstanceOf(LiveDeliveryFailed);
    expect(stopFailure).toMatchObject({ _tag: "LiveDeliveryFailed", stage: "stop" });
    expect(
      stopFailure instanceof LiveDeliveryFailed ? stopFailure.cause : undefined
    ).toBeInstanceOf(DriverOperationTimedOut);
    expect(
      stopFailure instanceof LiveDeliveryFailed &&
        stopFailure.cause instanceof DriverOperationTimedOut
        ? stopFailure.cause.operation
        : undefined
    ).toBe("live.stop");
  });

  test("unsupported live lease scopes are returned as typed failures", async () => {
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(graph.ensureNode({ spec: ProfileNode, args: {} }));

    const result = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: () => "not-json",
      })
    );

    expect(result.changed).toBe(false);
    expect(result.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
    expect(result.failures[0]).toBeInstanceOf(GraphInvariantViolation);
    expect(result.failures[0]).toMatchObject({
      invariant: "live lease scope must be a JSON-shaped key value",
    });
  });

  test("live demand is delivered to ready driver live work and stopped on inactive demand", async () => {
    const deliveries: Array<NodeLiveDemandSnapshot> = [];
    const cleanups: Array<{ readonly resource: string; readonly reason: string }> = [];

    type LiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LiveNode extends NodeBase<LiveSpec> {
      static readonly spec = resourceSpec<LiveSpec>({
        tag: "graph/resources/live",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (_ctx, demand) =>
              Effect.sync(() => {
                deliveries.push(demand);
                return "live";
              }),
            stop: (ctx, resource) =>
              Effect.sync(() => {
                cleanups.push({ resource, reason: ctx.reason._tag });
              }),
          }),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: LiveNode, args: {} }));
    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: lease.leaseId,
      })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));

    expect(deliveries).toEqual([
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "BTC/USD" }],
      },
    ]);
    expect(cleanups).toEqual([{ resource: "live", reason: "DemandInactive" }]);
  });

  test("node release eviction and graph stop close active live resources", async () => {
    async function runScenario(
      tag: string,
      close: (input: {
        readonly graph: ReturnType<typeof makeInMemoryGraphSystem>;
        readonly nodeId: NodeId;
      }) => Effect.Effect<unknown, unknown>
    ): Promise<ReadonlyArray<{ readonly resource: string; readonly reason: string }>> {
      const cleanups: Array<{ readonly resource: string; readonly reason: string }> = [];
      type LiveResourceSpec = NodeSpec<{
        readonly args: Record<string, never>;
        readonly key: Key.Singleton;
        readonly deps: Record<string, never>;
        readonly result: string;
      }>;

      class LiveResourceNode extends NodeBase<LiveResourceSpec> {
        static readonly spec = resourceSpec<LiveResourceSpec>({
          tag,
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<LiveResourceSpec>({
            acquire: Driver.Acquire(() => Effect.succeed("ready")),
            live: Driver.Live({
              start: () => Effect.succeed(tag),
              stop: (ctx, resource) =>
                Effect.sync(() => {
                  cleanups.push({ resource, reason: ctx.reason._tag });
                }),
            }),
          }),
        });
      }
      const graph = makeInMemoryGraphSystem();
      const handle = await Effect.runPromise(
        graph.ensureReadyNode({ spec: LiveResourceNode, args: {} })
      );
      await Effect.runPromise(
        graph.acquireNodeLiveLease({
          nodeId: handle.nodeId,
          source: "manual",
          scope: { pair: "BTC/USD" },
        })
      );

      await Effect.runPromise(close({ graph, nodeId: handle.nodeId }));

      return cleanups;
    }

    await expect(
      runScenario("graph/resources/live-release-cleanup", ({ graph, nodeId }) =>
        graph.releaseNode(nodeId)
      )
    ).resolves.toEqual([
      { resource: "graph/resources/live-release-cleanup", reason: "NodeReleased" },
    ]);
    await expect(
      runScenario("graph/resources/live-eviction-cleanup", ({ graph, nodeId }) =>
        graph.evictSubgraph({
          rootNodeIds: [nodeId],
          mode: "selfAndDependents",
          reason: "live cleanup test",
        })
      )
    ).resolves.toEqual([
      { resource: "graph/resources/live-eviction-cleanup", reason: "NodeEvicted" },
    ]);
    await expect(
      runScenario("graph/resources/live-stop-cleanup", ({ graph }) => graph.stop())
    ).resolves.toEqual([{ resource: "graph/resources/live-stop-cleanup", reason: "GraphStopped" }]);
  });

  test("async driver live delivery records demand cleanup and typed failures", async () => {
    const deliveries: Array<unknown> = [];
    const cleanups: Array<string> = [];
    type AsyncLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class AsyncLiveNode extends NodeBase<AsyncLiveSpec> {
      static readonly spec = resourceSpec<AsyncLiveSpec>({
        tag: "graph/resources/async-live",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Async<AsyncLiveSpec>({
          acquire: Driver.Acquire(async () => "ready"),
          live: Driver.Live({
            start: async (_ctx, demand) => {
              deliveries.push(demand);
              return "live";
            },
            stop: async (_ctx, resource) => {
              cleanups.push(resource);
            },
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: AsyncLiveNode, args: {} })
    );
    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: lease.leaseId,
      })
    );

    expect(deliveries).toEqual([
      {
        isLive: true,
        sources: ["manual"],
        scopes: [{ pair: "BTC/USD" }],
      },
    ]);
    expect(cleanups).toEqual(["live"]);

    const cause = new Error("async live rejected");
    type AsyncFailingLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class AsyncFailingLiveNode extends NodeBase<AsyncFailingLiveSpec> {
      static readonly spec = resourceSpec<AsyncFailingLiveSpec>({
        tag: "graph/resources/async-live-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Async<AsyncFailingLiveSpec>({
          acquire: Driver.Acquire(async () => "ready"),
          live: Driver.Live({
            start: async () => {
              throw cause;
            },
            stop: async () => undefined,
          }),
        }),
      });
    }
    const failingGraph = makeInMemoryGraphSystem();
    const failingHandle = await Effect.runPromise(
      failingGraph.ensureReadyNode({ spec: AsyncFailingLiveNode, args: {} })
    );
    const failingLease = await Effect.runPromise(
      failingGraph.acquireNodeLiveLease({
        nodeId: failingHandle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    expect(failingLease.failures[0]).toBeInstanceOf(LiveDeliveryFailed);
    expect(failingLease.failures[0]).toMatchObject({
      _tag: "LiveDeliveryFailed",
      stage: "start",
    });

    const failedSnapshot = await Effect.runPromise(failingGraph.snapshot());
    const failedNode = failedSnapshot.nodes.find((entry) => entry.nodeId === failingHandle.nodeId);

    expect(failedNode?.liveFailure?.failures[0]).toMatchObject({
      _tag: "LiveDeliveryFailed",
      stage: "start",
    });

    await Effect.runPromise(
      failingGraph.releaseNodeLiveLease({
        nodeId: failingHandle.nodeId,
        leaseId: failingLease.leaseId,
      })
    );
    const clearedSnapshot = await Effect.runPromise(failingGraph.snapshot());
    const clearedNode = clearedSnapshot.nodes.find(
      (entry) => entry.nodeId === failingHandle.nodeId
    );

    expect(clearedNode?.liveFailure).toBeUndefined();
  });

  test("live startup failure is stored and clears after later non-live cleanup", async () => {
    const cause = new Error("socket refused");
    type FailingLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FailingLiveNode extends NodeBase<FailingLiveSpec> {
      static readonly spec = resourceSpec<FailingLiveSpec>({
        tag: "graph/resources/live-start-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.fail(cause),
            stop: () => Effect.void,
          }),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: FailingLiveNode, args: {} })
    );
    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const failedSnapshot = await Effect.runPromise(graph.snapshot());
    const failedNode = failedSnapshot.nodes.find((entry) => entry.nodeId === handle.nodeId);

    expect(lease.failures).toHaveLength(1);
    expect(lease.failures[0]).toBeInstanceOf(LiveDeliveryFailed);
    expect(failedNode?.liveFailure?.failures[0]).toMatchObject({
      _tag: "LiveDeliveryFailed",
      stage: "start",
      cause,
    });

    await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: lease.leaseId,
      })
    );
    const clearedSnapshot = await Effect.runPromise(graph.snapshot());
    const clearedNode = clearedSnapshot.nodes.find((entry) => entry.nodeId === handle.nodeId);

    expect(clearedNode?.liveFailure).toBeUndefined();
  });

  test("live startup defects preserve Effect cause in typed failure", async () => {
    const cause = new TypeError("live died");
    type DefectLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class DefectLiveNode extends NodeBase<DefectLiveSpec> {
      static readonly spec = resourceSpec<DefectLiveSpec>({
        tag: "graph/resources/live-start-defect",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DefectLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.die(cause),
            stop: () => Effect.void,
          }),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DefectLiveNode, args: {} })
    );
    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const failure = lease.failures[0];
    const boundary = failure instanceof LiveDeliveryFailed ? failure.cause : undefined;

    expect(failure).toBeInstanceOf(LiveDeliveryFailed);
    expect(boundary).toBeInstanceOf(EffectBoundaryFailed);
    expect((boundary as EffectBoundaryFailed | undefined)?.boundary).toBe("driver-live");
    expect((boundary as EffectBoundaryFailed | undefined)?.cause).toBe(cause);
  });

  test("live stop failure is returned and stored on release", async () => {
    const cause = new Error("unsubscribe failed");
    type LiveDisposeFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LiveDisposeFailureNode extends NodeBase<LiveDisposeFailureSpec> {
      static readonly spec = resourceSpec<LiveDisposeFailureSpec>({
        tag: "graph/resources/live-dispose-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LiveDisposeFailureSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.succeed("live"),
            stop: () => Effect.fail(cause),
          }),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: LiveDisposeFailureNode, args: {} })
    );
    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const release = await Effect.runPromise(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: lease.leaseId,
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.nodeId === handle.nodeId);

    expect(release.failures).toHaveLength(1);
    expect(node?.liveFailure?.failures[0]).toMatchObject({
      _tag: "LiveDeliveryFailed",
      stage: "stop",
    });
  });

  test("live failure observers are best-effort and do not fail lease commands", async () => {
    const cause = new Error("socket refused");
    type FailingLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FailingLiveNode extends NodeBase<FailingLiveSpec> {
      static readonly spec = resourceSpec<FailingLiveSpec>({
        tag: "graph/resources/live-observer-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.fail(cause),
            stop: () => Effect.void,
          }),
        }),
      });
    }

    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: FailingLiveNode, args: {} })
    );

    await Effect.runPromise(graph.observeLiveFailures(() => Effect.fail(new Error("observer"))));

    const lease = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    expect(lease.failures[0]).toBeInstanceOf(LiveDeliveryFailed);
  });

  test("graph stop aborts the signal of an interrupted live start", async () => {
    let startSignal: AbortSignal | undefined;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    type HangingLiveSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class HangingLiveNode extends NodeBase<HangingLiveSpec> {
      static readonly spec = resourceSpec<HangingLiveSpec>({
        tag: "graph/resources/live-start-interrupt",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<HangingLiveSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: (ctx) =>
              Effect.sync(() => {
                startSignal = ctx.signal;
                markStarted();
              }).pipe(Effect.flatMap(() => Effect.never)),
            stop: () => Effect.void,
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: HangingLiveNode, args: {} })
    );
    const leasePromise = Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    ).catch(() => undefined);

    await started;

    expect(startSignal?.aborted).toBe(false);

    await Effect.runPromise(graph.stop());
    await leasePromise;

    expect(startSignal?.aborted).toBe(true);
  });
});
