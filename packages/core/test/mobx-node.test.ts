import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Match } from "effect";
import { autorun, observable, onBecomeObserved, onBecomeUnobserved } from "mobx";
import { Driver, Key } from "../src";
import { ActionFailed, GraphInvariantViolation, resultCommit } from "../src/graph";
import { createNode } from "../src/mobx";
import {
  type ActionContract,
  type Dep,
  dep,
  dependencies,
  FrondNodeClosed,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  serviceSpec,
} from "../src/node";
import { createRuntime } from "../src/runtime";
import { waitForRuntimeEvent, waitForRuntimeEventCount } from "../src/testing";

type Profile = {
  readonly name: string;
  timezone: string;
};

type TransportSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec<TransportSpec>({
    tag: "mobx/services/transport",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<TransportSpec>({
      acquire: Driver.Acquire(() => Effect.succeed("transport")),
    }),
  });
}

type ProfileSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly transport: Dep<typeof TransportNode>;
  };
  readonly result: Profile;
  readonly actions: {
    readonly updateTimezone: ActionContract<{ readonly timezone: string }, string>;
    readonly rejectTimezone: ActionContract<void, never>;
  };
}>;

class ProfileNode extends NodeBase<ProfileSpec> {
  static readonly spec = resourceSpec<ProfileSpec>({
    tag: "mobx/resources/profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      transport: dep(TransportNode, {}),
    })),
    driver: Driver.Effect<ProfileSpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.succeed({ name: ctx.deps.transport.result, timezone: "UTC" })
      ),
      refresh: Driver.Refresh((ctx) =>
        ctx.setResult({
          name: ctx.deps.transport.result,
          timezone: "PST",
        })
      ),
      actions: {
        updateTimezone: Driver.Action((ctx, input) =>
          Effect.gen(function* () {
            yield* ctx.patchResult((current) => {
              current.timezone = input.timezone;
            });

            return input.timezone;
          })
        ),
        rejectTimezone: Driver.Action(() => Effect.fail({ _tag: "TimezoneRejected" } as const)),
      },
    }),
  });
  get timezone(): string {
    return this.result.timezone;
  }
}

describe("MobX node projection", () => {
  test("mirrors runtime readiness into observable node state", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});
    const observedLabels: Array<string> = [];
    const stop = autorun(() => {
      observedLabels.push(projection.result?.timezone ?? "missing");
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(projection.result).toEqual({ name: "transport", timezone: "UTC" });
    expect(observedLabels).toContain("UTC");

    stop();
    projection.dispose();
  });

  test("syncs through one-node runtime snapshots", async () => {
    const runtime = createRuntime();
    const projection = createNode(
      {
        client: runtime.client,
        readNodeSnapshot: runtime.readNodeSnapshot,
        observe: runtime.observe,
      },
      ProfileNode,
      {}
    );

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.result).toEqual({ name: "transport", timezone: "UTC" });

    projection.dispose();
  });

  test("does not expose expired results as ordinary projected results", async () => {
    type ExpiredProfileSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: Profile;
    }>;

    class ExpiredProfileNode extends NodeBase<ExpiredProfileSpec> {
      static readonly spec = resourceSpec<ExpiredProfileSpec>({
        tag: "mobx/resources/expired-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ExpiredProfileSpec>({
          resultValidity: { _tag: "Manual" },
          acquire: Driver.Acquire(() =>
            Effect.succeed(
              resultCommit(
                { name: "transport", timezone: "expired" },
                {
                  validity: { _tag: "Expired", expiredAt: 10 },
                }
              )
            )
          ),
        }),
      });
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, ExpiredProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.resultValidity).toMatchObject({ _tag: "Expired", expiredAt: 10 });
    expect(projection.result).toBeUndefined();
    expect(projection.snapshot?.result).toBeUndefined();

    projection.dispose();
  });

  test("exposes a stable user node instance with strict runtime fields", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    expect(() => projection.node).toThrow("current node");

    await projection.ensure();

    expect(() => projection.node).toThrow("current node");

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.node).toBeInstanceOf(ProfileNode);
    expect(projection.node.nodeId).toBe(projection.nodeId);
    expect(projection.node.tag).toBe("mobx/resources/profile");
    expect(projection.node.args).toEqual({});
    expect(projection.node.result).toEqual({ name: "transport", timezone: "UTC" });
    expect(projection.node.deps.transport).toBeInstanceOf(TransportNode);
    expect(projection.node.deps.transport.result).toBe("transport");

    projection.dispose();
  });

  test("uses the graph-owned node object instead of constructing a projection copy", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const snapshot = await runtime.getSnapshot();
    const graphNode = snapshot.graph.nodes.find((entry) => entry.nodeId === projection.nodeId);

    expect(graphNode?.node).toBe(projection.node);

    projection.dispose();
  });

  test("driver node mutations are visible through the projected node", async () => {
    type MutableActions = {
      readonly mutateLabel: ActionContract<void, string>;
    };

    type MutableSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: null;
      readonly actions: MutableActions;
    }>;

    class MutableNode extends NodeBase<MutableSpec> {
      static readonly spec = resourceSpec<MutableSpec>({
        tag: "mobx/resources/node-mutation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<MutableSpec>({
          acquire: Driver.Acquire(() => Effect.succeed(null)),
          actions: {
            mutateLabel: Driver.Action((ctx) =>
              Effect.sync(() => {
                ctx.node.label = "mutated by driver";
                return ctx.node.label;
              })
            ),
          },
        }),
      });
      label = "initial";
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, MutableNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    await projection.node.actions.mutateLabel();
    expect(projection.node.label).toBe("mutated by driver");

    projection.dispose();
  });

  test("facade nodes can compute through dependency node objects", async () => {
    type FacadeSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly profile: Dep<typeof ProfileNode>;
      };
      readonly result: null;
    }>;

    class FacadeNode extends NodeBase<FacadeSpec> {
      static readonly spec = resourceSpec<FacadeSpec>({
        tag: "mobx/facades/profile-label",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          profile: dep(ProfileNode, {}),
        })),
        driver: Driver.Effect<FacadeSpec>({
          acquire: Driver.Acquire(() => Effect.succeed(null)),
        }),
      });
      get profileLabel(): string {
        return this.deps.profile.timezone;
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, FacadeNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.node.deps.profile).toBeInstanceOf(ProfileNode);
    expect(projection.node.profileLabel).toBe("UTC");

    projection.dispose();
  });

  test("routes domain actions and refresh through runtime handle and updates MobX node", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});
    const observedTimezones: Array<string> = [];

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const stop = autorun(() => {
      observedTimezones.push(projection.node.timezone);
    });

    const action = projection.node.actions.updateTimezone({ timezone: "CET" });

    expect(typeof action.then).toBe("function");

    const actionResult = await action;

    expect(actionResult).toBe("CET");
    expect(projection.result).toEqual({ name: "transport", timezone: "CET" });
    expect(projection.node.timezone).toBe("CET");
    expect(observedTimezones).toContain("CET");

    const refreshResult = await projection.refresh();

    expect(refreshResult).toEqual({
      _tag: "Success",
      nodeId: projection.nodeId,
      value: undefined,
    });
    expect(projection.node.result).toEqual({ name: "transport", timezone: "PST" });
    expect(observedTimezones).toContain("PST");

    stop();
    projection.dispose();
  });

  test("node domain action emits runtime action success events", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await projection.node.actions.updateTimezone({ timezone: "CET" });
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const actionStarts = events.filter((record) => record.event._tag === "GraphActionStarted");
    const actionSuccesses = events.filter((record) => record.event._tag === "GraphActionSucceeded");

    expect(actionStarts).toHaveLength(1);
    expect(actionStarts[0]?.work.source).toBe("node");
    expect(actionStarts[0]?.event).toMatchObject({
      _tag: "GraphActionStarted",
      action: "updateTimezone",
      input: { timezone: "CET" },
    });
    expect(actionSuccesses).toHaveLength(1);
    expect(actionSuccesses[0]?.work.source).toBe("node");
    expect(actionSuccesses[0]?.event).toMatchObject({
      _tag: "GraphActionSucceeded",
      action: "updateTimezone",
      input: { timezone: "CET" },
      value: "CET",
    });

    projection.dispose();
  });

  test("node domain action emits runtime action failure events", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await expect(projection.node.actions.rejectTimezone()).rejects.toBeInstanceOf(ActionFailed);
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const actionStarts = events.filter((record) => record.event._tag === "GraphActionStarted");
    const actionFailures = events.filter((record) => record.event._tag === "GraphActionFailed");
    const failureEvent = actionFailures[0]?.event;

    expect(actionStarts).toHaveLength(1);
    expect(actionStarts[0]?.work.source).toBe("node");
    expect(actionStarts[0]?.event).toMatchObject({
      _tag: "GraphActionStarted",
      action: "rejectTimezone",
    });
    expect(actionFailures).toHaveLength(1);
    expect(actionFailures[0]?.work.source).toBe("node");
    expect(failureEvent).toMatchObject({
      _tag: "GraphActionFailed",
      action: "rejectTimezone",
    });
    expect(
      failureEvent?._tag === "GraphActionFailed" ? failureEvent.error : undefined
    ).toBeInstanceOf(ActionFailed);

    projection.dispose();
  });

  test("MobX node methods record MobX work metadata", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await projection.runAction("updateTimezone", { timezone: "CET" });
    await projection.refresh();
    await projection.releaseResources("test release");
    await projection.evict("selfAndDependents", "test eviction");
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const recordsByTag = new Map(events.map((record) => [record.event._tag, record]));

    expect(recordsByTag.get("GraphNodeReadyEnsured")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphActionStarted")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphRefreshStarted")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphNodeReleased")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphNodesEvicted")?.work.source).toBe("mobx");

    projection.dispose();
  });

  test("node domain action bridge rejects failed actions with typed action failure", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    await expect(projection.node.actions.rejectTimezone()).rejects.toBeInstanceOf(ActionFailed);

    projection.dispose();
  });

  test("mirrors runtime operation state while preserving projected result", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    type SlowMobXSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class SlowMobXNode extends NodeBase<SlowMobXSpec> {
      static readonly spec = resourceSpec<SlowMobXSpec>({
        tag: "mobx/resources/slow-operation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowMobXSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({ value: "fresh" });
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const projection = createNode(runtime, SlowMobXNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const refresh = projection.refresh();
    await Effect.runPromise(Deferred.await(refreshStarted));
    await projection.sync();

    expect(projection.busy).toBe(true);
    expect(projection.operation).toMatchObject({ _tag: "Running", kind: "refresh" });
    expect(projection.result).toEqual({ value: "stable" });

    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    await refresh;

    expect(projection.busy).toBe(false);
    expect(projection.operationFailure).toBeUndefined();
    expect(projection.result).toEqual({ value: "fresh" });

    projection.dispose();
  });

  test("release clears projected result while preserving wired idle state", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await projection.releaseResources("test release");

    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(projection.result).toBeUndefined();
    expect(() => projection.node).toThrow("current node");

    projection.dispose();
  });

  test("evict clears the current graph-owned node and rewires a new generation", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const firstNode = projection.node;
    const result = await projection.evict("selfAndDependents", "test eviction");

    expect(result.nodeIds).toContain(projection.nodeId);
    expect(projection.status).toEqual({ _tag: "Unwired" });
    expect(projection.result).toBeUndefined();
    expect(() => projection.node).toThrow("current node");

    await projection.ensureReady();

    expect(projection.node).toBeInstanceOf(ProfileNode);
    expect(projection.node).not.toBe(firstNode);
    expect(projection.node.timezone).toBe("UTC");

    projection.dispose();
  });

  test("observing graph-owned node result creates a MobX live lease", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.node.result;
    });

    await waitForRuntimeEvent(runtime, "GraphNodeLiveDemandChanged");

    const observed = await projection.snapshot;

    expect(observed?.liveDemand).toEqual({
      isLive: true,
      sources: ["mobx"],
      scopes: [{ field: "result" }],
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("observing graph-owned result payload creates scoped MobX live demand", async () => {
    type Pair = "BTC/USD" | "ETH/USD";
    type RatesResult = {
      readonly rates: ReturnType<typeof observable.map<Pair, number>>;
    };

    type ScopedRatesSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: RatesResult;
    }>;

    class ScopedRatesNode extends NodeBase<ScopedRatesSpec> {
      static readonly spec = resourceSpec<ScopedRatesSpec>({
        tag: "mobx/resources/scoped-rates",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ScopedRatesSpec>({
          acquire: Driver.Acquire(() =>
            Effect.succeed({
              rates: observable.map<Pair, number>([
                ["BTC/USD", 1],
                ["ETH/USD", 2],
              ]),
            })
          ),
        }),
      });
      constructor() {
        super();

        for (const pair of this.result.rates.keys()) {
          this.onRuntimeClose(
            onBecomeObserved(this.result.rates, pair, () => {
              this.reportPairObserved(pair, true);
            })
          );
          this.onRuntimeClose(
            onBecomeUnobserved(this.result.rates, pair, () => {
              this.reportPairObserved(pair, false);
            })
          );
        }
      }

      rate(pair: Pair): number {
        return this.untrackedResult().rates.get(pair) ?? 0;
      }

      reportPairObserved(pair: Pair, observed: boolean): void {
        this.reportResultObserved({ field: "rates", pair }, observed);
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, ScopedRatesNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.node.rate("BTC/USD");
    });

    await waitForRuntimeEvent(runtime, "GraphNodeLiveDemandChanged");
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: true,
      sources: ["mobx"],
      scopes: [{ field: "rates", pair: "BTC/USD" }],
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("unsupported MobX live scopes surface typed live failures", async () => {
    type UnsupportedScopeSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class UnsupportedScopeNode extends NodeBase<UnsupportedScopeSpec> {
      static readonly spec = resourceSpec<UnsupportedScopeSpec>({
        tag: "mobx/resources/unsupported-live-scope",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<UnsupportedScopeSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        }),
      });
      reportUnsupportedScope(): void {
        this.reportResultObserved(Symbol("scope"), true);
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, UnsupportedScopeNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    projection.node.reportUnsupportedScope();

    const record = await waitForRuntimeEvent(runtime, "GraphNodeLiveFailed");
    expect(record.failures[0]).toBeInstanceOf(GraphInvariantViolation);

    await projection.sync();
    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("rapid result payload unobserve releases the acquired scoped live lease", async () => {
    type Pair = "BTC/USD";
    type RatesResult = {
      readonly rates: ReturnType<typeof observable.map<Pair, number>>;
    };

    type RapidScopedRatesSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: RatesResult;
    }>;

    class RapidScopedRatesNode extends NodeBase<RapidScopedRatesSpec> {
      static readonly spec = resourceSpec<RapidScopedRatesSpec>({
        tag: "mobx/resources/rapid-scoped-rates",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RapidScopedRatesSpec>({
          acquire: Driver.Acquire(() =>
            Effect.succeed({
              rates: observable.map<Pair, number>([["BTC/USD", 1]]),
            })
          ),
        }),
      });
      constructor() {
        super();

        this.onRuntimeClose(
          onBecomeObserved(this.result.rates, "BTC/USD", () => {
            this.reportPairObserved("BTC/USD", true);
          })
        );
        this.onRuntimeClose(
          onBecomeUnobserved(this.result.rates, "BTC/USD", () => {
            this.reportPairObserved("BTC/USD", false);
          })
        );
      }

      rate(): number {
        return this.untrackedResult().rates.get("BTC/USD") ?? 0;
      }

      reportPairObserved(pair: Pair, observed: boolean): void {
        this.reportResultObserved({ field: "rates", pair }, observed);
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, RapidScopedRatesNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.node.rate();
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("observing projection mirror result does not create duplicate live demand", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.result;
    });
    await Promise.resolve();

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(events.some((record) => record.event._tag === "GraphNodeLiveDemandChanged")).toBe(false);

    stop();
    projection.dispose();
  });

  test("stale node action after release is closed and fresh node can act after reacquire", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const staleNode = projection.node;
    await projection.releaseResources("test release");

    await expect(staleNode.actions.updateTimezone({ timezone: "EET" })).rejects.toThrow(
      FrondNodeClosed
    );
    await projection.ensureReady();

    const result = await projection.node.actions.updateTimezone({ timezone: "EET" });

    expect(result).toBe("EET");
    expect(projection.node.timezone).toBe("EET");

    projection.dispose();
  });

  test("ensureReady exposes pending state before slow acquire completes", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<Profile>());
    type SlowProfileSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: Profile;
    }>;

    class SlowProfileNode extends NodeBase<SlowProfileSpec> {
      static readonly spec = resourceSpec<SlowProfileSpec>({
        tag: "mobx/resources/slow-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const projection = createNode(runtime, SlowProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    const ready = projection.ensureReady();
    await Effect.runPromise(Deferred.await(started));
    await projection.sync();

    const runState = Match.value(projection.status).pipe(
      Match.tag("Wired", ({ run }) => run._tag),
      Match.orElse(() => "not-wired")
    );

    expect(runState).toBe("Pending");

    await Effect.runPromise(Deferred.succeed(gate, { name: "slow", timezone: "UTC" }));
    await ready;

    expect(projection.node.result).toEqual({ name: "slow", timezone: "UTC" });

    projection.dispose();
  });
});
