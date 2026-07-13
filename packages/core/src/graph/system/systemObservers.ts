import type { Effect } from "effect";
import type {
  GraphActionCompletionObserver,
  GraphCleanupFailureObserver,
  GraphLiveDemandObserver,
  GraphLiveFailureObserver,
  GraphNodeChangeObserver,
  GraphObserverFailure,
  GraphObserverFailureObserver,
  GraphOperationStartObserver,
  GraphResultValidityObserver,
  GraphSubscription,
} from "../types";
import { makeObserverChannel } from "./observerChannel";

export interface GraphSystemObservers {
  readonly observeNodeChanges: (
    observer: GraphNodeChangeObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeResultValidityChanges: (
    observer: GraphResultValidityObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeLiveDemandChanges: (
    observer: GraphLiveDemandObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeLiveFailures: (
    observer: GraphLiveFailureObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeCleanupFailures: (
    observer: GraphCleanupFailureObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeOperationStarts: (
    observer: GraphOperationStartObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeActionCompletions: (
    observer: GraphActionCompletionObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeObserverFailures: (
    observer: GraphObserverFailureObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly notifyNodeChanged: GraphNodeChangeObserver;
  readonly notifyResultValidityChanged: GraphResultValidityObserver;
  readonly notifyLiveDemandChanged: GraphLiveDemandObserver;
  readonly notifyLiveFailures: GraphLiveFailureObserver;
  readonly notifyCleanupFailures: GraphCleanupFailureObserver;
  readonly notifyOperationStarted: GraphOperationStartObserver;
  readonly notifyActionCompleted: GraphActionCompletionObserver;
}

export function makeGraphSystemObservers(): GraphSystemObservers {
  const observerFailures = makeObserverChannel<
    GraphObserverFailureObserver,
    Parameters<GraphObserverFailureObserver>
  >();
  const reportObserverFailure = (failure: GraphObserverFailure) =>
    observerFailures.notifyAll(failure);
  const nodeChange = makeObserverChannel<
    GraphNodeChangeObserver,
    Parameters<GraphNodeChangeObserver>
  >({
    channel: "node-change",
    reportFailure: reportObserverFailure,
  });
  const resultValidity = makeObserverChannel<
    GraphResultValidityObserver,
    Parameters<GraphResultValidityObserver>
  >({
    channel: "result-validity",
    reportFailure: reportObserverFailure,
  });
  const liveDemandChanges = makeObserverChannel<
    GraphLiveDemandObserver,
    Parameters<GraphLiveDemandObserver>
  >({
    channel: "live-demand",
    reportFailure: reportObserverFailure,
  });
  const liveFailures = makeObserverChannel<
    GraphLiveFailureObserver,
    Parameters<GraphLiveFailureObserver>
  >({
    channel: "live-failure",
    reportFailure: reportObserverFailure,
  });
  const cleanupFailures = makeObserverChannel<
    GraphCleanupFailureObserver,
    Parameters<GraphCleanupFailureObserver>
  >({
    channel: "cleanup-failure",
    reportFailure: reportObserverFailure,
  });
  const operationStarts = makeObserverChannel<
    GraphOperationStartObserver,
    Parameters<GraphOperationStartObserver>
  >({
    channel: "operation-start",
    reportFailure: reportObserverFailure,
  });
  const actionCompletions = makeObserverChannel<
    GraphActionCompletionObserver,
    Parameters<GraphActionCompletionObserver>
  >({
    channel: "action-completion",
    reportFailure: reportObserverFailure,
  });

  return {
    observeNodeChanges: nodeChange.subscribe,
    observeResultValidityChanges: resultValidity.subscribe,
    observeLiveDemandChanges: liveDemandChanges.subscribe,
    observeLiveFailures: liveFailures.subscribe,
    observeCleanupFailures: cleanupFailures.subscribe,
    observeOperationStarts: operationStarts.subscribe,
    observeActionCompletions: actionCompletions.subscribe,
    observeObserverFailures: observerFailures.subscribe,
    notifyNodeChanged: nodeChange.notifyAll,
    notifyResultValidityChanged: resultValidity.notifyAll,
    notifyLiveDemandChanged: liveDemandChanges.notifyAll,
    notifyLiveFailures: liveFailures.notifyAll,
    notifyCleanupFailures: cleanupFailures.notifyAll,
    notifyOperationStarted: operationStarts.notifyAll,
    notifyActionCompleted: actionCompletions.notifyAll,
  };
}
