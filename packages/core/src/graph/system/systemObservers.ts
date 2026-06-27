import type { Effect } from "effect";
import type {
  GraphActionCompleted,
  GraphActionCompletionObserver,
  GraphCleanupFailureObserver,
  GraphLiveDemandObserver,
  GraphLiveFailureObserver,
  GraphNodeChangeObserver,
  GraphObserverFailure,
  GraphObserverFailureObserver,
  GraphOperationStarted,
  GraphOperationStartObserver,
  GraphResultValidityObserver,
  GraphSubscription,
  NodeId,
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
  const observerFailures = makeObserverChannel<GraphObserverFailureObserver>();
  const reportObserverFailure = (failure: GraphObserverFailure) =>
    observerFailures.notifyAll(failure, (observedFailure, observer) => observer(observedFailure));
  const nodeChange = makeObserverChannel<GraphNodeChangeObserver, NodeId>({
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
    { readonly nodeId: NodeId; readonly liveDemand: Parameters<GraphLiveDemandObserver>[1] }
  >({
    channel: "live-demand",
    reportFailure: reportObserverFailure,
  });
  const liveFailures = makeObserverChannel<
    GraphLiveFailureObserver,
    { readonly nodeId: NodeId; readonly failures: Parameters<GraphLiveFailureObserver>[1] }
  >({
    channel: "live-failure",
    reportFailure: reportObserverFailure,
  });
  const cleanupFailures = makeObserverChannel<
    GraphCleanupFailureObserver,
    {
      readonly nodeId: NodeId;
      readonly reason: Parameters<GraphCleanupFailureObserver>[1];
      readonly failures: Parameters<GraphCleanupFailureObserver>[2];
    }
  >({
    channel: "cleanup-failure",
    reportFailure: reportObserverFailure,
  });
  const operationStarts = makeObserverChannel<GraphOperationStartObserver, GraphOperationStarted>({
    channel: "operation-start",
    reportFailure: reportObserverFailure,
  });
  const actionCompletions = makeObserverChannel<
    GraphActionCompletionObserver,
    GraphActionCompleted
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
    notifyNodeChanged: (nodeId) =>
      nodeChange.notifyAll(nodeId, (observedNodeId, observer) => observer(observedNodeId)),
    notifyResultValidityChanged: (...args) =>
      resultValidity.notifyAll(args, (observedArgs, observer) => observer(...observedArgs)),
    notifyLiveDemandChanged: (nodeId, liveDemand) =>
      liveDemandChanges.notifyAll(
        { nodeId, liveDemand },
        ({ nodeId: observedNodeId, liveDemand: observedDemand }, observer) =>
          observer(observedNodeId, observedDemand)
      ),
    notifyLiveFailures: (nodeId: NodeId, failures) =>
      liveFailures.notifyAll(
        { nodeId, failures },
        ({ nodeId: observedNodeId, failures: observedFailures }, observer) =>
          observer(observedNodeId, observedFailures)
      ),
    notifyCleanupFailures: (nodeId: NodeId, reason, failures) =>
      cleanupFailures.notifyAll(
        { nodeId, reason, failures },
        (
          { nodeId: observedNodeId, reason: observedReason, failures: observedFailures },
          observer
        ) => observer(observedNodeId, observedReason, observedFailures)
      ),
    notifyOperationStarted: (started) =>
      operationStarts.notifyAll(started, (observedStarted, observer) => observer(observedStarted)),
    notifyActionCompleted: (completed) =>
      actionCompletions.notifyAll(completed, (observedCompleted, observer) =>
        observer(observedCompleted)
      ),
  };
}
