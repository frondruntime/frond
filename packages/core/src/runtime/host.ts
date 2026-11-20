import { type Context, Effect, Exit } from "effect";
import { withGraphSignalAccess } from "../graph/config";
import {
  finishObserverWork,
  interruptObserverWork,
  runEffectEdge,
} from "../graph/driverExecution/effectRunner";
import {
  callbackEffect,
  type GraphCancel,
  GraphReply,
  type GraphResume,
  noCancel,
} from "../graph/queue/reply";
import { makeInMemoryGraphSystemFromConfig } from "../graph/system";
import { canonicalArgs } from "../keys";
import { attachRuntimeCore, type RuntimeCore } from "./core";
import { FrondRuntimeClosed } from "./errors";
import { makeRuntimeEventBus } from "./eventBus";
import {
  graphCommandSpanAttributes,
  graphCommandSpanName,
  runRuntimeGraphCommand,
} from "./graphCommands";
import { runtimeCommandAttributes, runtimeCommandSpanName, withRuntimeSpan } from "./observability";
import {
  makeRuntimeOperationStartRegistry,
  runtimeEventTagForGraphObserverChannel,
} from "./operationStarts";
import { normalizeRuntimeOptions } from "./options";
import { makeRuntimeSignalBus } from "./signalBus";
import type {
  RuntimeCommand,
  RuntimeError,
  RuntimeEvent,
  RuntimeHostService,
  RuntimeOptions,
  RuntimeQueryResult,
  RuntimeStatus,
  RuntimeSubmission,
} from "./types";
import { makeRuntimeWorkFactory, type RuntimeWorkContext, type RuntimeWorkDefaults } from "./work";

export const makeRuntimeHost = (options: RuntimeOptions = {}): Effect.Effect<RuntimeHostService> =>
  Effect.gen(function* () {
    const config = normalizeRuntimeOptions(options);
    const runtimeId = config.runtimeId;
    const syncClock = config.syncClock;
    const workFactory = makeRuntimeWorkFactory(runtimeId);
    const eventBus = makeRuntimeEventBus({
      ...config.eventBus,
      syncClock,
      fallbackWork: () => workFactory.defaultWork,
    });
    const signalBus = makeRuntimeSignalBus({
      runtimeId,
      syncClock,
      eventBus,
      policies: config.signalBus.policies,
      subscribers: config.signalBus.subscribers,
    });
    const operationStarts = makeRuntimeOperationStartRegistry();
    const { service: graphSystem, core: graphCore } = makeInMemoryGraphSystemFromConfig(
      withGraphSignalAccess(config.graphConfig, signalBus)
    );
    const graphOperationStartSubscription = yield* graphSystem.observeOperationStarts((started) => {
      const { event, work } = operationStarts.recordStarted(started, (reason) =>
        workFactory.nextWork(
          undefined,
          workDefaults(
            "node",
            reason,
            reason === "refresh" || reason === "live" ? "background" : "visible"
          )
        )
      );
      return eventBus.emit(event, work);
    });
    const graphActionCompletionSubscription = yield* graphSystem.observeActionCompletions(
      (completed) => {
        const { event, work } = operationStarts.recordActionCompleted(completed, () =>
          workFactory.nextWork(undefined, workDefaults("node", "action", "visible"))
        );
        return eventBus.emit(event, work);
      }
    );
    const graphObserverFailureSubscription = yield* graphSystem.observeObserverFailures((failure) =>
      eventBus.emit({
        _tag: "RuntimeObserverFailureObserved",
        eventTag: runtimeEventTagForGraphObserverChannel(failure),
        cause: failure.cause,
        at: syncClock.now(),
      })
    );
    const graphNodeChangeSubscription = yield* graphSystem.observeNodeChanges((nodeId) =>
      eventBus.emit({ _tag: "GraphNodeChanged", nodeId, at: syncClock.now() })
    );
    const graphResultValiditySubscription = yield* graphSystem.observeResultValidityChanges(
      (nodeId, previous, next, reason) =>
        eventBus.emit({
          _tag: "GraphNodeResultValidityChanged",
          nodeId,
          previous,
          next,
          reason,
          at: syncClock.now(),
        })
    );
    const graphLiveDemandSubscription = yield* graphSystem.observeLiveDemandChanges(
      (nodeId, liveDemand) =>
        eventBus.emit({
          _tag: "GraphNodeLiveDemandChanged",
          nodeId,
          liveDemand,
          at: syncClock.now(),
        })
    );
    const graphLiveFailureSubscription = yield* graphSystem.observeLiveFailures(
      (nodeId, failures) =>
        eventBus.emit({ _tag: "GraphNodeLiveFailed", nodeId, failures, at: syncClock.now() })
    );
    const graphReadinessFailureSubscription = yield* graphSystem.observeReadinessFailures(
      (nodeId, error) =>
        eventBus.emit({ _tag: "GraphNodeReadinessFailed", nodeId, error, at: syncClock.now() })
    );
    const graphCleanupFailureSubscription = yield* graphSystem.observeCleanupFailures(
      (nodeId, reason, failures) =>
        eventBus.emit({
          _tag: "GraphNodeCleanupFailed",
          nodeId,
          reason,
          failures,
          at: syncClock.now(),
        })
    );

    const graphSubscriptions = [
      graphOperationStartSubscription,
      graphActionCompletionSubscription,
      graphObserverFailureSubscription,
      graphNodeChangeSubscription,
      graphResultValiditySubscription,
      graphLiveDemandSubscription,
      graphLiveFailureSubscription,
      graphReadinessFailureSubscription,
      graphCleanupFailureSubscription,
    ];
    let lifecycle: HostLifecycle = idleLifecycle;
    // Set once the stop sweeps observer work: a sink started after that would
    // outlive the stop, so a late diagnostic is dropped instead.
    let observerWorkSwept = false;
    let inputIngestionEnabled = config.inputIngestionEnabled;

    const resolveNodeIdSync: RuntimeHostService["resolveNodeIdSync"] = (request) => {
      canonicalArgs(request.args);

      return graphSystem.resolveNodeIdSync(request);
    };

    const getStatusSync: RuntimeHostService["getStatusSync"] = () => lifecycle.status;
    const syncProjectionContext = () => ({ now: syncClock.now() });
    const readNodeSnapshotSync: RuntimeHostService["readNodeSnapshotSync"] = (nodeId) =>
      graphSystem.readNodeSnapshotSync(nodeId, syncProjectionContext());
    const readNodeRevisionSync: RuntimeHostService["readNodeRevisionSync"] = (nodeId) =>
      graphSystem.readNodeRevisionSync(nodeId);
    const readPendingOperationsSync: RuntimeHostService["readPendingOperationsSync"] = () =>
      graphSystem.readPendingOperationsSync();
    const readNodeSnapshot: RuntimeHostService["readNodeSnapshot"] = (nodeId) =>
      Effect.sync(() => readNodeSnapshotSync(nodeId));
    const submitDirect = (
      command: RuntimeCommand,
      context: Context.Context<never> | undefined,
      resume: GraphResume<RuntimeSubmission, RuntimeError>,
      suppliedWork?: RuntimeWorkContext
    ): GraphCancel => {
      const work =
        suppliedWork ?? workFactory.nextWork(command.metadata, commandWorkDefaults(command));
      const emit = (event: RuntimeEvent) => eventBus.emit(event, work);
      if (lifecycle.status === "stopped" && command._tag !== "RuntimeStop") {
        resume(Exit.fail(runtimeClosed(command._tag)));
        return noCancel;
      }
      switch (command._tag) {
        case "RuntimeStart": {
          if (lifecycle.status === "running") {
            resume(Exit.succeed({ _tag: "RuntimeStarted" }));
            return noCancel;
          }
          lifecycle = runningLifecycle;
          const at = syncClock.now();
          return graphCore.start(context, (exit) => {
            if (exit._tag === "Failure") {
              resume(Exit.failCause(exit.cause));
              return;
            }
            finishObserverWork(
              emit({ _tag: "RuntimeStarted", at }),
              context,
              () => {
                finishObserverWork(
                  emit({ _tag: "GraphSystemStarted", at }),
                  context,
                  () => resume(Exit.succeed({ _tag: "RuntimeStarted" })),
                  graphCore.jobs
                );
              },
              graphCore.jobs
            );
          });
        }
        case "RuntimeStop": {
          if (lifecycle.status === "stopped") return lifecycle.stopReply.listen(resume);
          const reply = new GraphReply<RuntimeSubmission, RuntimeError>();
          lifecycle = { status: "stopped", stopReply: reply };
          const at = syncClock.now();
          graphCore.stop(context, (exit) => {
            if (exit._tag === "Failure") {
              reply.settle(Exit.failCause(exit.cause));
              return;
            }
            const results = exit.value;
            // Sinks still running for work the stop interrupted end before the
            // stop's own events, which run after them. From the sweep on, every
            // other event reaches its listeners and starts no sink.
            observerWorkSwept = true;
            eventBus.closeSinks();
            interruptObserverWork(graphCore.jobs, () => {
              for (const subscription of graphSubscriptions) subscription.unsubscribe();
              let index = 0;
              const emitCleanup = (): void => {
                while (index < results.length) {
                  const result = results[index++];
                  if (result === undefined || result.failures.length === 0) continue;
                  finishObserverWork(
                    eventBus.emitClosing(
                      {
                        _tag: "GraphNodeCleanupFailed",
                        nodeId: result.nodeId,
                        reason: "runtime-stop",
                        failures: result.failures,
                        at,
                      },
                      work
                    ),
                    context,
                    emitCleanup,
                    graphCore.jobs
                  );
                  return;
                }
                finishObserverWork(
                  eventBus.emitClosing({ _tag: "GraphSystemStopped", at }, work),
                  context,
                  () => {
                    finishObserverWork(
                      eventBus.emitClosing(
                        { _tag: "RuntimeStopped", at, reason: command.reason },
                        work
                      ),
                      context,
                      () => reply.settle(Exit.succeed({ _tag: "RuntimeStopped" })),
                      graphCore.jobs
                    );
                  },
                  graphCore.jobs
                );
              };
              emitCleanup();
            });
          });
          return reply.listen(resume);
        }
        default:
          return runRuntimeGraphCommand(
            {
              command,
              graphSystem,
              graphCore,
              syncClock,
              work,
              emit,
              syncProjectionContext,
              operationStarts,
            },
            context,
            resume
          );
      }
    };
    const submit: RuntimeHostService["submit"] = (command) => {
      const work = workFactory.nextWork(command.metadata, commandWorkDefaults(command));
      const effect = callbackEffect<RuntimeSubmission, RuntimeError>((context, resume) =>
        submitDirect(command, context, resume, work)
      );
      const traced =
        command._tag === "RuntimeStart" || command._tag === "RuntimeStop"
          ? effect
          : withRuntimeSpan(
              effect,
              graphCommandSpanName(command),
              graphCommandSpanAttributes(runtimeId, command, work)
            );
      return withRuntimeSpan(
        traced,
        runtimeCommandSpanName(command),
        runtimeCommandAttributes(runtimeId, command, work)
      );
    };

    const jobs = graphCore.jobs;
    const runOpen = (
      operation: string,
      run: () => void,
      resume: GraphResume<void, RuntimeError>
    ): GraphCancel => {
      let canceled = false;
      jobs.post({
        run: () => {
          if (canceled) return;
          if (lifecycle.status === "stopped") {
            resume(Exit.fail(runtimeClosed(operation)));
            return;
          }
          try {
            run();
          } catch (cause) {
            resume(Exit.die(cause));
          }
        },
      });
      return () => {
        canceled = true;
        return Effect.void;
      };
    };
    const core: RuntimeCore = {
      submit: submitDirect,
      control: (control, context, resume) =>
        runOpen(
          control._tag,
          () => {
            const work = workFactory.nextWork(control.metadata, {
              source: "manual",
              reason: "input",
              priority: "background",
            });
            inputIngestionEnabled = control.enabled;
            finishObserverWork(
              eventBus.emit(
                { _tag: "InputIngestionChanged", enabled: control.enabled, at: syncClock.now() },
                work
              ),
              context,
              () => resume(Exit.succeed(undefined)),
              jobs
            );
          },
          resume
        ),
      ingest: (input, context, resume) =>
        runOpen(
          input._tag,
          () => {
            const work = workFactory.nextWork(input.metadata, {
              source: "manual",
              reason: "input",
              priority: "visible",
            });
            if (!inputIngestionEnabled) {
              resume(Exit.succeed(undefined));
              return;
            }
            const at = syncClock.now();
            finishObserverWork(
              eventBus.emit({ _tag: "RuntimeInputReceived", input, at }, work),
              context,
              () => {
                graphCore.handleInputSync();
                finishObserverWork(
                  eventBus.emit(
                    { _tag: "GraphSystemInputObserved", inputTag: input._tag, at },
                    work
                  ),
                  context,
                  () => resume(Exit.succeed(undefined)),
                  jobs
                );
              },
              jobs
            );
          },
          resume
        ),
      publish: (signal, metadata, context, resume) => {
        if (lifecycle.status === "stopped") {
          resume(Exit.fail(runtimeClosed("RuntimeSignalPublish")));
          return noCancel;
        }
        const work = workFactory.nextWork(metadata, {
          source: "signal",
          reason: "signal",
          priority: "background",
        });
        let cancelWork: GraphCancel = noCancel;
        const cancelAdmission = runOpen(
          "RuntimeSignalPublish",
          () => {
            cancelWork = runEffectEdge(signalBus.publish(signal, work), context, resume);
          },
          resume
        );
        return () => {
          // Both cancels act when called; their Effects run in order.
          const admissionCanceled = cancelAdmission();
          return Effect.andThen(admissionCanceled, cancelWork());
        };
      },
      recordUnsafeScheduleFailure: (command, cause, context, resume) => {
        if (observerWorkSwept) {
          resume(Exit.succeed(undefined));
          return noCancel;
        }
        const work = workFactory.nextWork(undefined, {
          source: "devtools",
          reason: "unsafe-update",
          priority: "background",
        });
        finishObserverWork(
          eventBus.emit(
            {
              _tag: "RuntimeObserverFailureObserved",
              eventTag: command._tag,
              cause,
              at: syncClock.now(),
            },
            work
          ),
          context,
          () => resume(Exit.succeed(undefined)),
          jobs
        );
        return noCancel;
      },
      recordMobXProjectionFailure: (_nodeId, cause, context, resume) => {
        if (observerWorkSwept) {
          resume(Exit.succeed(undefined));
          return noCancel;
        }
        const work = workFactory.nextWork(undefined, {
          source: "mobx",
          reason: "input",
          priority: "visible",
        });
        finishObserverWork(
          eventBus.emit(
            {
              _tag: "RuntimeObserverFailureObserved",
              eventTag: "MobXProjectionSync",
              cause,
              at: syncClock.now(),
            },
            work
          ),
          context,
          () => resume(Exit.succeed(undefined)),
          jobs
        );
        return noCancel;
      },
      querySync: (query): RuntimeQueryResult => {
        switch (query._tag) {
          case "RuntimeStatus":
            return {
              _tag: "RuntimeStatus",
              runtimeId,
              status: lifecycle.status,
              inputIngestionEnabled,
            };
          case "RuntimeEvents":
            return { _tag: "RuntimeEvents", runtimeId, events: eventBus.events(query.limit) };
          case "RuntimeSinks":
            return { _tag: "RuntimeSinks", sinks: eventBus.sinks() };
          case "RuntimeSignals":
            return {
              _tag: "RuntimeSignals",
              runtimeId,
              records: signalBus.recordsSync({ channel: query.channel, limit: query.limit }),
            };
          case "RuntimeSignalSubscribers":
            return { _tag: "RuntimeSignalSubscribers", subscribers: signalBus.subscribersSync() };
          default: {
            const exhaustive: never = query;
            return exhaustive;
          }
        }
      },
      getSnapshotSync: () => ({
        runtimeId,
        status: lifecycle.status,
        inputIngestionEnabled,
        events: eventBus.events(),
        sinks: eventBus.sinks(),
        signals: signalBus.recordsSync(),
        signalSubscribers: signalBus.subscribersSync(),
        graph: graphCore.snapshotSync(),
      }),
      subscribeSignalsSync: (subscriber) => {
        if (lifecycle.status === "stopped") throw runtimeClosed("RuntimeSignalSubscribe");
        return signalBus.subscribeSync(subscriber);
      },
      observeSync: eventBus.observeSync,
      resolveValidatedNodeIdSync: graphSystem.resolveNodeIdSync,
      hasPendingJobsSync: graphCore.jobs.hasPendingJobs,
    };
    const host: RuntimeHostService = {
      resolveNodeIdSync,
      getStatusSync,
      readNodeSnapshotSync,
      readNodeRevisionSync,
      readPendingOperationsSync,
      readNodeSnapshot,
      submit,
      control: (command) =>
        callbackEffect((context, resume) => core.control(command, context, resume)),
      query: (query) => Effect.sync(() => core.querySync(query)),
      ingest: (input) => callbackEffect((context, resume) => core.ingest(input, context, resume)),
      publish: (signal, metadata) =>
        callbackEffect((context, resume) => core.publish(signal, metadata, context, resume)),
      subscribeSignals: (subscriber) =>
        Effect.try({
          try: () => core.subscribeSignalsSync(subscriber),
          catch: (cause) => cause as RuntimeError,
        }),
      recordUnsafeScheduleFailure: (command, cause) =>
        callbackEffect((context, resume) =>
          core.recordUnsafeScheduleFailure(command, cause, context, resume)
        ),
      recordMobXProjectionFailure: (nodeId, cause) =>
        callbackEffect((context, resume) =>
          core.recordMobXProjectionFailure(nodeId, cause, context, resume)
        ),
      getSnapshot: () => Effect.sync(core.getSnapshotSync),
      observe: (observer, nodeId) => Effect.sync(() => core.observeSync(observer, nodeId)),
    };
    attachRuntimeCore(host, core);
    return host;
  });

/**
 * A host is idle until started, and stopped is terminal: it holds the first
 * stop's reply, which every later stop caller awaits.
 */
type HostLifecycle =
  | { readonly status: Exclude<RuntimeStatus, "stopped"> }
  | {
      readonly status: "stopped";
      readonly stopReply: GraphReply<RuntimeSubmission, RuntimeError>;
    };

const idleLifecycle: HostLifecycle = { status: "idle" };
const runningLifecycle: HostLifecycle = { status: "running" };

function runtimeClosed(operation: string): FrondRuntimeClosed {
  return new FrondRuntimeClosed({ operation });
}

function commandWorkDefaults(command: RuntimeCommand): RuntimeWorkDefaults {
  switch (command._tag) {
    case "RuntimeStart":
      return workDefaults("runtime", "start", "background");
    case "RuntimeStop":
      return workDefaults("runtime", "stop", "blocking");
    case "GraphEnsureNode":
    case "GraphEnsureReadyNode":
      return workDefaults("manual", "readiness", "visible");
    case "GraphEnsureReadyNodeById":
      return workDefaults("devtools", "readiness", "visible");
    case "GraphRunAction":
      return workDefaults("manual", "action", "visible");
    case "GraphRefreshNode":
      return workDefaults("manual", "refresh", "background");
    case "GraphUpdateNodeArgs":
      return workDefaults("manual", "args-update", "visible");
    case "GraphUnsafeUpdateNode":
      return workDefaults("devtools", "unsafe-update", "visible");
    case "GraphReleaseNode":
      return workDefaults("manual", "release", "background");
    case "GraphEvictSubgraph":
      return workDefaults("manual", "eviction", "blocking");
    case "GraphAcquireNodeLiveLease":
    case "GraphReleaseNodeLiveLease":
      return workDefaults("manual", "live", "background");
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}

function workDefaults(
  source: RuntimeWorkDefaults["source"],
  reason: RuntimeWorkDefaults["reason"],
  priority: RuntimeWorkDefaults["priority"]
): RuntimeWorkDefaults {
  return { source, reason, priority };
}
