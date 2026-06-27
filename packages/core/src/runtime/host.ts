import { Clock, Deferred, Effect, Match } from "effect";
import type { NodeId } from "../graph";
import { withGraphSignalAccess } from "../graph/config";
import { makeInMemoryGraphSystemFromConfig } from "../graph/system";
import type { EvictSubgraphRequest } from "../graph/types/operations";
import { FrondRuntimeClosed } from "./errors";
import { makeRuntimeEventBus } from "./eventBus";
import { RuntimeEvents } from "./events";
import { type RuntimeGraphCommand, runRuntimeGraphCommand } from "./graphCommands";
import { runtimeCommandAttributes, runtimeCommandSpanName, withRuntimeSpan } from "./observability";
import {
  makeRuntimeOperationStartRegistry,
  runtimeEventTagForGraphObserverChannel,
} from "./operationStarts";
import { normalizeRuntimeOptions } from "./options";
import { makeRuntimeScope } from "./scope";
import { makeRuntimeSignalBus } from "./signalBus";
import type {
  RuntimeCommand,
  RuntimeControl,
  RuntimeEvent,
  RuntimeHostService,
  RuntimeInput,
  RuntimeOptions,
  RuntimeQuery,
  RuntimeQueryResult,
  RuntimeSnapshot,
  RuntimeStatus,
  RuntimeSubmission,
} from "./types";
import { makeRuntimeWorkFactory, type RuntimeWorkDefaults } from "./work";

export const makeRuntimeHost = (options: RuntimeOptions = {}): Effect.Effect<RuntimeHostService> =>
  Effect.gen(function* () {
    const config = normalizeRuntimeOptions(options);
    const runtimeId = config.runtimeId;
    const syncClock = config.syncClock;
    const workFactory = makeRuntimeWorkFactory(runtimeId);
    const eventBus = makeRuntimeEventBus({
      ...config.eventBus,
      currentWork: () => workFactory.defaultWork,
    });
    const signalBus = makeRuntimeSignalBus({
      runtimeId,
      eventBus,
      policies: config.signalBus.policies,
      subscribers: config.signalBus.subscribers,
    });
    const runtimeScope = makeRuntimeScope();
    const operationStarts = makeRuntimeOperationStartRegistry();
    const graphSystem = makeInMemoryGraphSystemFromConfig(
      withGraphSignalAccess(config.graphConfig, signalBus)
    );
    const graphOperationStartSubscription = yield* graphSystem.observeOperationStarts((started) =>
      Effect.sync(() =>
        operationStarts.recordStarted(started, (reason) =>
          workFactory.nextWork(
            undefined,
            workDefaults(
              "node",
              reason,
              reason === "refresh" || reason === "live" ? "background" : "visible"
            )
          )
        )
      ).pipe(Effect.flatMap(({ event, work }) => eventBus.emit(event, work)))
    );
    const graphActionCompletionSubscription = yield* graphSystem.observeActionCompletions(
      (completed) =>
        Effect.sync(() =>
          operationStarts.recordActionCompleted(completed, () =>
            workFactory.nextWork(undefined, workDefaults("node", "action", "visible"))
          )
        ).pipe(Effect.flatMap(({ event, work }) => eventBus.emit(event, work)))
    );
    const graphObserverFailureSubscription = yield* graphSystem.observeObserverFailures((failure) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        yield* eventBus.emit(
          RuntimeEvents.runtimeObserverFailureObserved(
            runtimeEventTagForGraphObserverChannel(failure),
            failure.cause,
            at
          )
        );
      })
    );
    const graphNodeChangeSubscription = yield* graphSystem.observeNodeChanges((nodeId) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        yield* eventBus.emit(RuntimeEvents.graphNodeChanged(nodeId, at));
      })
    );
    const graphResultValiditySubscription = yield* graphSystem.observeResultValidityChanges(
      (nodeId, previous, next, reason) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          yield* eventBus.emit(
            RuntimeEvents.graphNodeResultValidityChanged(nodeId, previous, next, reason, at)
          );
        })
    );
    const graphLiveDemandSubscription = yield* graphSystem.observeLiveDemandChanges(
      (nodeId, liveDemand) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          yield* eventBus.emit(RuntimeEvents.graphNodeLiveDemandChanged(nodeId, liveDemand, at));
        })
    );
    const graphLiveFailureSubscription = yield* graphSystem.observeLiveFailures(
      (nodeId, failures) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          yield* eventBus.emit(RuntimeEvents.graphNodeLiveFailed(nodeId, failures, at));
        })
    );
    const graphCleanupFailureSubscription = yield* graphSystem.observeCleanupFailures(
      (nodeId, reason, failures) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          yield* eventBus.emit(RuntimeEvents.graphNodeCleanupFailed(nodeId, reason, failures, at));
        })
    );

    let status: RuntimeStatus = "idle";
    let inputIngestionEnabled = config.inputIngestionEnabled;
    let graphSubscriptionsClosed = false;
    let stopDeferred: Deferred.Deferred<RuntimeSubmission> | undefined;

    const resolveNodeIdSync: RuntimeHostService["resolveNodeIdSync"] = (request) =>
      graphSystem.resolveNodeIdSync(request);

    const getStatusSync: RuntimeHostService["getStatusSync"] = () => status;
    const syncProjectionContext = () => ({ now: syncClock.now() });
    const readNodeSnapshotSync: RuntimeHostService["readNodeSnapshotSync"] = (nodeId) =>
      graphSystem.readNodeSnapshotSync(nodeId, syncProjectionContext());
    const readNodeSnapshot: RuntimeHostService["readNodeSnapshot"] = (nodeId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* graphSystem.readNodeSnapshot(nodeId, { now });
      });
    // Contract: stopped runtime is terminal for work-producing commands, but
    // read/inspection APIs remain available for final state and diagnostics.
    const admitRuntimeOpen = (operation: string): Effect.Effect<void, FrondRuntimeClosed> =>
      status === "stopped" ? Effect.fail(runtimeClosed(operation)) : Effect.void;
    const admitRuntimeWork = <TValue, TError, TRequirements>(
      operation: string,
      run: () => Effect.Effect<TValue, TError, TRequirements>
    ): Effect.Effect<TValue, TError | FrondRuntimeClosed, TRequirements> =>
      admitRuntimeOpen(operation).pipe(Effect.flatMap(() => Effect.suspend(run)));
    const admitRuntimeCommand = (
      command: RuntimeCommand
    ): Effect.Effect<void, FrondRuntimeClosed> =>
      command._tag === "RuntimeStop" ? Effect.void : admitRuntimeOpen(command._tag);

    const submit = (command: Parameters<RuntimeHostService["submit"]>[0]) => {
      const work = workFactory.nextWork(command.metadata, commandWorkDefaults(command));
      const emit = (event: RuntimeEvent): Effect.Effect<void> => eventBus.emit(event, work);
      const runGraphCommand = (graphCommand: RuntimeGraphCommand) =>
        runRuntimeGraphCommand({
          command: graphCommand,
          graphSystem,
          runtimeId,
          work,
          emit,
          syncProjectionContext,
          operationStarts,
        });
      const commandEffect = Effect.gen(function* () {
        yield* admitRuntimeCommand(command);

        return yield* Match.value(command).pipe(
          Match.tag("RuntimeStart", () =>
            Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis;

              status = "running";
              yield* graphSystem.start();
              yield* emit(RuntimeEvents.runtimeStarted(at));
              yield* emit(RuntimeEvents.graphSystemStarted(at));
              return { _tag: "RuntimeStarted" } satisfies RuntimeSubmission;
            })
          ),
          Match.tag("RuntimeStop", ({ reason }) => stopRuntime(reason, emit)),
          Match.tag("GraphEnsureNode", runGraphCommand),
          Match.tag("GraphEnsureReadyNode", runGraphCommand),
          Match.tag("GraphEnsureReadyNodeById", runGraphCommand),
          Match.tag("GraphRunAction", runGraphCommand),
          Match.tag("GraphRefreshNode", runGraphCommand),
          Match.tag("GraphUpdateNodeArgs", runGraphCommand),
          Match.tag("GraphUnsafeUpdateNode", runGraphCommand),
          Match.tag("GraphReleaseNode", runGraphCommand),
          Match.tag("GraphEvictSubgraph", runGraphCommand),
          Match.tag("GraphAcquireNodeLiveLease", runGraphCommand),
          Match.tag("GraphReleaseNodeLiveLease", runGraphCommand),
          Match.exhaustive
        );
      });

      return withRuntimeSpan(
        commandEffect,
        runtimeCommandSpanName(command),
        runtimeCommandAttributes(runtimeId, command, work)
      );
    };

    const control = (controlInput: RuntimeControl) =>
      admitRuntimeWork(controlInput._tag, () => {
        const work = workFactory.nextWork(controlInput.metadata, {
          source: "manual",
          reason: "input",
          priority: "background",
        });

        return Match.value(controlInput).pipe(
          Match.tag("SetInputIngestion", ({ enabled }) =>
            Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis;

              inputIngestionEnabled = enabled;
              yield* eventBus.emit(RuntimeEvents.inputIngestionChanged(enabled, at), work);
            })
          ),
          Match.exhaustive
        );
      });

    const query = (runtimeQuery: RuntimeQuery): Effect.Effect<RuntimeQueryResult> =>
      Match.value(runtimeQuery).pipe(
        Match.tag("RuntimeStatus", () =>
          Effect.succeed({
            _tag: "RuntimeStatus",
            runtimeId,
            status,
            inputIngestionEnabled,
          } satisfies RuntimeQueryResult)
        ),
        Match.tag("RuntimeEvents", ({ limit }) =>
          Effect.sync(
            () =>
              ({
                _tag: "RuntimeEvents",
                runtimeId,
                events: eventBus.events(limit),
              }) satisfies RuntimeQueryResult
          )
        ),
        Match.tag("RuntimeSinks", () =>
          Effect.succeed({
            _tag: "RuntimeSinks",
            sinks: eventBus.sinks(),
          } satisfies RuntimeQueryResult)
        ),
        Match.tag("RuntimeSignals", ({ channel, limit }) =>
          Effect.gen(function* () {
            const records = yield* signalBus.records({ channel, limit });

            return {
              _tag: "RuntimeSignals",
              runtimeId,
              records,
            } satisfies RuntimeQueryResult;
          })
        ),
        Match.tag("RuntimeSignalSubscribers", () =>
          Effect.gen(function* () {
            const subscribers = yield* signalBus.subscribers();

            return {
              _tag: "RuntimeSignalSubscribers",
              subscribers,
            } satisfies RuntimeQueryResult;
          })
        ),
        Match.exhaustive
      );

    const ingest = (input: RuntimeInput) =>
      admitRuntimeWork(input._tag, () => {
        const work = workFactory.nextWork(input.metadata, {
          source: "manual",
          reason: "input",
          priority: "visible",
        });

        return inputIngestionEnabled
          ? Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis;
              yield* eventBus.emit(RuntimeEvents.runtimeInputReceived(input, at), work);
              yield* graphSystem.handleInput(input);
              yield* eventBus.emit(RuntimeEvents.graphSystemInputObserved(input._tag, at), work);
            })
          : Effect.void;
      });

    const publish: RuntimeHostService["publish"] = (signal, metadata) =>
      admitRuntimeWork("RuntimeSignalPublish", () => {
        const work = workFactory.nextWork(metadata, {
          source: "signal",
          reason: "signal",
          priority: "background",
        });

        return signalBus.publish(signal, work);
      });

    const subscribeSignals: RuntimeHostService["subscribeSignals"] = (subscriber) =>
      admitRuntimeWork("RuntimeSignalSubscribe", () => signalBus.subscribe(subscriber));

    const getSnapshot = (): Effect.Effect<RuntimeSnapshot> => getSnapshotFor("diagnostics");

    const getSnapshotFor = (_purpose: Parameters<RuntimeHostService["getSnapshotFor"]>[0]) =>
      Effect.gen(function* () {
        const graph = yield* graphSystem.snapshot();
        const signals = yield* signalBus.records();
        const signalSubscribers = yield* signalBus.subscribers();

        return {
          runtimeId,
          status,
          inputIngestionEnabled,
          events: eventBus.events(),
          sinks: eventBus.sinks(),
          signals,
          signalSubscribers,
          graph,
        };
      });

    const observe: RuntimeHostService["observe"] = (observer) => eventBus.observe(observer);

    function closeGraphSubscriptions(): void {
      if (graphSubscriptionsClosed) {
        return;
      }

      graphSubscriptionsClosed = true;
      graphOperationStartSubscription.unsubscribe();
      graphActionCompletionSubscription.unsubscribe();
      graphObserverFailureSubscription.unsubscribe();
      graphNodeChangeSubscription.unsubscribe();
      graphResultValiditySubscription.unsubscribe();
      graphLiveDemandSubscription.unsubscribe();
      graphLiveFailureSubscription.unsubscribe();
      graphCleanupFailureSubscription.unsubscribe();
    }

    function stopRuntime(
      reason: string | undefined,
      emit: (event: RuntimeEvent) => Effect.Effect<void>
    ): Effect.Effect<RuntimeSubmission> {
      // Contract: stop is idempotent and shared. The first call owns cleanup
      // and event emission; concurrent and later callers await the same settled
      // result instead of acknowledging success while cleanup is still running.
      if (stopDeferred !== undefined) {
        return Deferred.await(stopDeferred);
      }

      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<RuntimeSubmission, never>();
        stopDeferred = deferred;
        const exit = yield* Effect.exit(runStopRuntime(reason, emit));

        yield* Deferred.done(deferred, exit);
        return yield* Deferred.await(deferred);
      });
    }

    function runStopRuntime(
      reason: string | undefined,
      emit: (event: RuntimeEvent) => Effect.Effect<void>
    ): Effect.Effect<RuntimeSubmission> {
      return Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        status = "stopped";
        const cleanupResults = yield* graphSystem.stop();
        closeGraphSubscriptions();
        // Contract: cleanup failures are emitted before GraphSystemStopped and
        // RuntimeStopped so sinks can report resource failures while runtime
        // context is still intact.
        yield* Effect.forEach(
          cleanupResults,
          (result) =>
            result.failures.length === 0
              ? Effect.void
              : emit(
                  RuntimeEvents.graphNodeCleanupFailed(
                    result.nodeId,
                    "runtime-stop",
                    result.failures,
                    at
                  )
                ),
          { concurrency: 1, discard: true }
        );
        yield* emit(RuntimeEvents.graphSystemStopped(at));
        yield* runtimeScope.close();
        yield* emit(RuntimeEvents.runtimeStopped(at, reason));
        return { _tag: "RuntimeStopped" } satisfies RuntimeSubmission;
      });
    }

    return {
      resolveNodeIdSync,
      getStatusSync,
      readNodeSnapshotSync,
      readNodeSnapshot,
      submit,
      control,
      query,
      ingest,
      publish,
      subscribeSignals,
      getSnapshot,
      getSnapshotFor,
      observe,
    };
  });

function runtimeClosed(operation: string): FrondRuntimeClosed {
  return new FrondRuntimeClosed({ operation });
}

function commandWorkDefaults(command: RuntimeCommand): RuntimeWorkDefaults {
  return Match.value(command).pipe(
    Match.tag("RuntimeStart", () => workDefaults("runtime", "start", "background")),
    Match.tag("RuntimeStop", () => workDefaults("runtime", "stop", "blocking")),
    Match.tag("GraphEnsureNode", () => workDefaults("manual", "readiness", "visible")),
    Match.tag("GraphEnsureReadyNode", () => workDefaults("manual", "readiness", "visible")),
    Match.tag("GraphEnsureReadyNodeById", () => workDefaults("devtools", "readiness", "visible")),
    Match.tag("GraphRunAction", () => workDefaults("manual", "action", "visible")),
    Match.tag("GraphRefreshNode", () => workDefaults("manual", "refresh", "background")),
    Match.tag("GraphUpdateNodeArgs", () => workDefaults("manual", "args-update", "visible")),
    Match.tag("GraphUnsafeUpdateNode", () => workDefaults("devtools", "unsafe-update", "visible")),
    Match.tag("GraphReleaseNode", () => workDefaults("manual", "release", "background")),
    Match.tag("GraphEvictSubgraph", () => workDefaults("manual", "eviction", "blocking")),
    Match.tag("GraphAcquireNodeLiveLease", () => workDefaults("manual", "live", "background")),
    Match.tag("GraphReleaseNodeLiveLease", () => workDefaults("manual", "live", "background")),
    Match.exhaustive
  );
}

function workDefaults(
  source: RuntimeWorkDefaults["source"],
  reason: RuntimeWorkDefaults["reason"],
  priority: RuntimeWorkDefaults["priority"]
): RuntimeWorkDefaults {
  return { source, reason, priority };
}

export function evictNodeRequest(
  nodeId: NodeId,
  mode: EvictSubgraphRequest["mode"],
  reason?: string | undefined
): EvictSubgraphRequest {
  return { rootNodeIds: [nodeId], mode, cancellation: { _tag: "Evicted", detail: reason }, reason };
}
