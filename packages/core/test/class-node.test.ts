import { afterEach, describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { autorun, observable, onBecomeObserved, onBecomeUnobserved } from "mobx";
import { Driver, Key, unwrapEffect } from "../src";
import { ActionFailed, GraphInvariantViolation, type NodeId } from "../src/graph";
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
import { createRuntime, type Runtime } from "../src/runtime";
import { waitForRuntimeEvent, waitForRuntimeEventCount } from "../src/testing";

type Profile = {
  readonly name: string;
  timezone: string;
};

type TransportSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec.effect<TransportSpec>({
    tag: "mobx/services/transport",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed("transport")),
  });
}

type ProfileSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly transport: Dep<typeof TransportNode>;
  };
  readonly result: Profile;
  readonly actions: {
    readonly updateTimezone: ActionContract<
      { readonly timezone: string },
      { readonly timezone: string }
    >;
    readonly rejectTimezone: ActionContract<void, never>;
  };
}>;

class ProfileNode extends NodeBase<ProfileSpec> {
  static readonly spec = resourceSpec.effect<ProfileSpec>({
    tag: "mobx/resources/profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      transport: dep(TransportNode, {}),
    })),
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

          return { timezone: input.timezone };
        })
      ),
      rejectTimezone: Driver.Action(() => Effect.fail({ _tag: "TimezoneRejected" } as const)),
    },
  });
  get timezone(): string {
    return this.result.timezone;
  }
}

const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

function liveDemand(runtime: Runtime, nodeId: NodeId) {
  const lookup = runtime.readNodeSnapshotSync(nodeId);
  if (lookup._tag !== "Found") throw new Error("Expected a node snapshot");
  return lookup.snapshot.liveDemand;
}

describe("class node handles and observation", () => {
  test("driver node mutations are visible through the handle node", async () => {
    type MutableActions = {
      readonly mutateLabel: ActionContract<void, string>;
    };

    type MutableSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: null;
      readonly actions: MutableActions;
    }>;

    class MutableNode extends NodeBase<MutableSpec> {
      static readonly spec = resourceSpec.effect<MutableSpec>({
        tag: "mobx/resources/node-mutation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed(null)),
        actions: {
          mutateLabel: Driver.Action((ctx) =>
            Effect.sync(() => {
              ctx.node.label = "mutated by driver";
              return ctx.node.label;
            })
          ),
        },
      });
      label = "initial";
    }

    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(MutableNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();

    await unwrapEffect(handle.readReady().actions.mutateLabel());
    expect(handle.readReady().label).toBe("mutated by driver");
  });

  test("facade nodes can compute through dependency node objects", async () => {
    type FacadeSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly profile: Dep<typeof ProfileNode>;
      };
      readonly result: null;
    }>;

    class FacadeNode extends NodeBase<FacadeSpec> {
      static readonly spec = resourceSpec.effect<FacadeSpec>({
        tag: "mobx/facades/profile-label",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          profile: dep(ProfileNode, {}),
        })),
        acquire: Driver.Acquire(() => Effect.succeed(null)),
      });
      get profileLabel(): string {
        return this.deps.profile.timezone;
      }
    }

    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(FacadeNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();

    expect(handle.readReady().deps.profile).toBeInstanceOf(ProfileNode);
    expect(handle.readReady().profileLabel).toBe("UTC");
  });

  test("routes domain actions and refresh through runtime handle and updates the class node", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(ProfileNode, {});
    const observedTimezones: Array<string> = [];

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();
    const stop = autorun(() => {
      observedTimezones.push(handle.readReady().timezone);
    });

    const action = unwrapEffect(handle.readReady().actions.updateTimezone({ timezone: "CET" }));

    expect(typeof action.then).toBe("function");

    const actionResult = await action;

    expect(actionResult).toEqual({ timezone: "CET" });
    expect(handle.readReady().result).toEqual({ name: "transport", timezone: "CET" });
    expect(handle.readReady().timezone).toBe("CET");
    expect(observedTimezones).toContain("CET");

    const refreshResult = await handle.refresh();

    expect(refreshResult).toEqual({
      _tag: "Success",
      nodeId: handle.nodeId,
      value: { name: "transport", timezone: "PST" },
    });
    expect(handle.readReady().result).toEqual({ name: "transport", timezone: "PST" });
    expect(observedTimezones).toContain("PST");

    stop();
  });

  test("node domain action emits runtime action success events", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();
    await unwrapEffect(handle.readReady().actions.updateTimezone({ timezone: "CET" }));
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
      value: { timezone: "CET" },
    });
  });

  test("node domain action emits runtime action failure events", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();
    await expect(unwrapEffect(handle.readReady().actions.rejectTimezone())).rejects.toBeInstanceOf(
      ActionFailed
    );
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
  });

  test("observing graph-owned node result creates a MobX live lease", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();

    const stop = autorun(() => {
      void handle.readReady().result;
    });

    await waitForRuntimeEvent(runtime, "GraphNodeLiveDemandChanged");

    const observed = liveDemand(runtime, handle.nodeId);

    expect(observed).toEqual({
      isLive: true,
      sources: ["mobx"],
      scopes: [{ field: "result" }],
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);

    expect(liveDemand(runtime, handle.nodeId)).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
  });

  test("observed-result live start failure does not leave phantom MobX demand", async () => {
    const failure = new Error("live start failed once");
    let starts = 0;
    type FlakyLiveSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FlakyLiveNode extends NodeBase<FlakyLiveSpec> {
      static readonly spec = resourceSpec.effect<FlakyLiveSpec>({
        tag: "mobx/resources/flaky-live",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
        live: Driver.Live({
          start: () =>
            Effect.sync(() => {
              starts += 1;
            }).pipe(
              Effect.flatMap(() => (starts === 1 ? Effect.fail(failure) : Effect.succeed("live")))
            ),
          stop: () => Effect.void,
        }),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(FlakyLiveNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();

    const stop = autorun(() => {
      void handle.readReady().result;
    });

    await waitForRuntimeEvent(runtime, "GraphNodeLiveFailed");

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);

    expect(liveDemand(runtime, handle.nodeId)).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
    expect(starts).toBe(1);
  });

  test("unsupported MobX live scopes surface typed live failures", async () => {
    type UnsupportedScopeSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class UnsupportedScopeNode extends NodeBase<UnsupportedScopeSpec> {
      static readonly spec = resourceSpec.effect<UnsupportedScopeSpec>({
        tag: "mobx/resources/unsupported-live-scope",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
      });
      reportUnsupportedScope(): void {
        this.reportResultObserved(Symbol("scope"), true);
      }
    }

    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(UnsupportedScopeNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();

    handle.readReady().reportUnsupportedScope();

    const record = await waitForRuntimeEvent(runtime, "GraphNodeLiveFailed");
    expect(record.failures[0]).toBeInstanceOf(GraphInvariantViolation);

    expect(liveDemand(runtime, handle.nodeId)).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
  });

  test("rapid result payload unobserve releases the acquired scoped live lease", async () => {
    type Pair = "BTC/USD";
    type RatesResult = {
      readonly rates: ReturnType<typeof observable.map<Pair, number>>;
    };

    type RapidScopedRatesSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: RatesResult;
    }>;

    class RapidScopedRatesNode extends NodeBase<RapidScopedRatesSpec> {
      static readonly spec = resourceSpec.effect<RapidScopedRatesSpec>({
        tag: "mobx/resources/rapid-scoped-rates",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.succeed({
            rates: observable.map<Pair, number>([["BTC/USD", 1]]),
          })
        ),
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

    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(RapidScopedRatesNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();

    const stop = autorun(() => {
      void handle.readReady().rate();
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);

    expect(liveDemand(runtime, handle.nodeId)).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
  });

  test("invalidation rolls back an observation lease interrupted during live start", async () => {
    const liveStarted = await Effect.runPromise(Deferred.make<void>());
    const liveGate = await Effect.runPromise(Deferred.make<void>());
    let liveStarts = 0;
    type InterruptedObservationSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly values: ReturnType<typeof observable.map<string, string>> };
    }>;

    class InterruptedObservationNode extends NodeBase<InterruptedObservationSpec> {
      static readonly spec = resourceSpec.effect<InterruptedObservationSpec>({
        tag: "mobx/resources/interrupted-observation-lease",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.succeed({ values: observable.map([["value", "ready"]]) })
        ),
        live: Driver.Live({
          start: () =>
            Effect.gen(function* () {
              liveStarts += 1;
              yield* Deferred.succeed(liveStarted, undefined);
              yield* Deferred.await(liveGate);
              return "live";
            }),
          stop: () => Effect.void,
        }),
      });

      constructor() {
        super();
        this.onRuntimeClose(
          onBecomeObserved(this.result.values, "value", () => {
            this.reportResultObserved({ field: "values", key: "value" }, true);
          })
        );
        this.onRuntimeClose(
          onBecomeUnobserved(this.result.values, "value", () => {
            this.reportResultObserved({ field: "values", key: "value" }, false);
          })
        );
      }

      readValue(): string | undefined {
        return this.untrackedResult().values.get("value");
      }
    }

    class ConflictingObservationNode extends NodeBase<InterruptedObservationSpec> {
      static readonly spec = resourceSpec.effect<InterruptedObservationSpec>({
        tag: "mobx/resources/interrupted-observation-lease",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.succeed({ values: observable.map([["value", "conflict"]]) })
        ),
      });
    }

    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(InterruptedObservationNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();
    const node = handle.readReady();

    const stopObserving = autorun(() => {
      void node.readValue();
    });
    await Effect.runPromise(Deferred.await(liveStarted));

    await runtime.submit({
      _tag: "GraphEnsureNode",
      request: { spec: ConflictingObservationNode, args: {} },
    });

    expect(liveDemand(runtime, handle.nodeId)).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    stopObserving();
    await handle.ensureReady();
    expect(liveStarts).toBe(1);
  });

  test("invalidation releases a successfully acquired observation lease by id", async () => {
    type InvalidatedObservationSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class InvalidatedObservationNode extends NodeBase<InvalidatedObservationSpec> {
      static readonly spec = resourceSpec.effect<InvalidatedObservationSpec>({
        tag: "mobx/resources/invalidated-observation-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        live: Driver.Live({
          start: () => Effect.succeed("live"),
          stop: () => Effect.void,
        }),
      });
    }

    class ConflictingInvalidatedObservationNode extends NodeBase<InvalidatedObservationSpec> {
      static readonly spec = resourceSpec.effect<InvalidatedObservationSpec>({
        tag: "mobx/resources/invalidated-observation-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "conflict" })),
      });
    }

    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(InvalidatedObservationNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();
    const node = handle.readReady();

    const stopObserving = autorun(
      () => {
        void node.result;
      },
      { onError: () => undefined }
    );
    await waitForRuntimeEvent(runtime, "GraphNodeLiveDemandChanged");

    await runtime.submit({
      _tag: "GraphEnsureNode",
      request: { spec: ConflictingInvalidatedObservationNode, args: {} },
    });
    // Invalidation teardown and the observation release now post queue jobs.
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);

    expect(liveDemand(runtime, handle.nodeId)).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    stopObserving();
  });

  test("stale node action after release is closed and fresh node can act after reacquire", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    const handle = runtime.client.node(ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await handle.ensureReady();
    const staleNode = handle.readReady();
    await handle.releaseResources("test release");

    await expect(
      unwrapEffect(staleNode.actions.updateTimezone({ timezone: "EET" }))
    ).rejects.toThrow(FrondNodeClosed);
    await handle.ensureReady();

    const result = await unwrapEffect(
      handle.readReady().actions.updateTimezone({ timezone: "EET" })
    );

    expect(result).toEqual({ timezone: "EET" });
    expect(handle.readReady().timezone).toBe("EET");
  });
});
