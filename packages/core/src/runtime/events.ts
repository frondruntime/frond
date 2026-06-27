import { Match } from "effect";
import type { NodeId } from "../graph";
import type { RuntimeEvent, RuntimeInput } from "./types";

export const RuntimeEvents = {
  runtimeStarted: (at: number): RuntimeEvent => ({
    _tag: "RuntimeStarted",
    at,
  }),

  runtimeStopped: (at: number, reason?: string): RuntimeEvent => ({
    _tag: "RuntimeStopped",
    at,
    reason,
  }),

  inputIngestionChanged: (enabled: boolean, at: number): RuntimeEvent => ({
    _tag: "InputIngestionChanged",
    enabled,
    at,
  }),

  runtimeInputReceived: (input: RuntimeInput, at: number): RuntimeEvent => ({
    _tag: "RuntimeInputReceived",
    input,
    at,
  }),

  runtimeSignalPublished: (
    record: Extract<RuntimeEvent, { readonly _tag: "RuntimeSignalPublished" }>["record"],
    at: number
  ): RuntimeEvent => ({
    _tag: "RuntimeSignalPublished",
    record,
    at,
  }),

  runtimeSignalSubscriberFailureObserved: (
    subscriber: string,
    signal: Extract<
      RuntimeEvent,
      { readonly _tag: "RuntimeSignalSubscriberFailureObserved" }
    >["signal"],
    cause: unknown,
    at: number
  ): RuntimeEvent => ({
    _tag: "RuntimeSignalSubscriberFailureObserved",
    subscriber,
    signal,
    cause,
    at,
  }),

  runtimeSinkFailureObserved: (
    sink: string,
    eventTag: RuntimeEvent["_tag"],
    cause: unknown,
    at: number
  ): RuntimeEvent => ({
    _tag: "RuntimeSinkFailureObserved",
    sink,
    eventTag,
    cause,
    at,
  }),

  runtimeObserverFailureObserved: (
    eventTag: RuntimeEvent["_tag"],
    cause: unknown,
    at: number
  ): RuntimeEvent => ({
    _tag: "RuntimeObserverFailureObserved",
    eventTag,
    cause,
    at,
  }),

  graphSystemStarted: (at: number): RuntimeEvent => ({
    _tag: "GraphSystemStarted",
    at,
  }),

  graphSystemStopped: (at: number): RuntimeEvent => ({
    _tag: "GraphSystemStopped",
    at,
  }),

  graphSystemInputObserved: (inputTag: RuntimeInput["_tag"], at: number): RuntimeEvent => ({
    _tag: "GraphSystemInputObserved",
    inputTag,
    at,
  }),

  graphNodeEnsured: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeEnsured" }>["nodeId"],
    status: Extract<RuntimeEvent, { readonly _tag: "GraphNodeEnsured" }>["status"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeEnsured",
    nodeId,
    status,
    at,
  }),

  graphNodeReadyEnsured: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeReadyEnsured" }>["nodeId"],
    status: Extract<RuntimeEvent, { readonly _tag: "GraphNodeReadyEnsured" }>["status"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeReadyEnsured",
    nodeId,
    status,
    at,
  }),

  graphNodeChanged: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeChanged" }>["nodeId"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeChanged",
    nodeId,
    at,
  }),

  graphActionStarted: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphActionStarted" }>["nodeId"],
    action: string,
    input: unknown,
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphActionStarted",
    nodeId,
    action,
    input,
    at,
  }),

  graphActionSucceeded: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphActionSucceeded" }>["nodeId"],
    action: string,
    input: unknown,
    value: unknown,
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphActionSucceeded",
    nodeId,
    action,
    input,
    value,
    at,
  }),

  graphActionFailed: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphActionFailed" }>["nodeId"],
    action: string,
    input: unknown,
    error: Extract<RuntimeEvent, { readonly _tag: "GraphActionFailed" }>["error"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphActionFailed",
    nodeId,
    action,
    input,
    error,
    at,
  }),

  graphRefreshStarted: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphRefreshStarted" }>["nodeId"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphRefreshStarted",
    nodeId,
    at,
  }),

  graphRefreshSucceeded: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphRefreshSucceeded" }>["nodeId"],
    value: unknown,
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphRefreshSucceeded",
    nodeId,
    value,
    at,
  }),

  graphRefreshFailed: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphRefreshFailed" }>["nodeId"],
    error: Extract<RuntimeEvent, { readonly _tag: "GraphRefreshFailed" }>["error"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphRefreshFailed",
    nodeId,
    error,
    at,
  }),

  graphNodeArgsUpdateStarted: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeArgsUpdateStarted" }>["nodeId"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeArgsUpdateStarted",
    nodeId,
    at,
  }),

  graphNodeArgsUpdateSucceeded: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeArgsUpdateSucceeded" }>["nodeId"],
    shouldRefresh: boolean,
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeArgsUpdateSucceeded",
    nodeId,
    shouldRefresh,
    at,
  }),

  graphNodeArgsUpdateFailed: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeArgsUpdateFailed" }>["nodeId"],
    error: Extract<RuntimeEvent, { readonly _tag: "GraphNodeArgsUpdateFailed" }>["error"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeArgsUpdateFailed",
    nodeId,
    error,
    at,
  }),

  graphUnsafeNodeUpdated: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphUnsafeNodeUpdated" }>["nodeId"],
    label: Extract<RuntimeEvent, { readonly _tag: "GraphUnsafeNodeUpdated" }>["label"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphUnsafeNodeUpdated",
    nodeId,
    label,
    at,
  }),

  graphUnsafeNodeUpdateFailed: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphUnsafeNodeUpdateFailed" }>["nodeId"],
    label: Extract<RuntimeEvent, { readonly _tag: "GraphUnsafeNodeUpdateFailed" }>["label"],
    error: Extract<RuntimeEvent, { readonly _tag: "GraphUnsafeNodeUpdateFailed" }>["error"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphUnsafeNodeUpdateFailed",
    nodeId,
    label,
    error,
    at,
  }),

  graphNodeReleased: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeReleased" }>["nodeId"],
    reason: Extract<RuntimeEvent, { readonly _tag: "GraphNodeReleased" }>["reason"],
    at: number,
    failure: Extract<RuntimeEvent, { readonly _tag: "GraphNodeReleased" }>["failure"]
  ): RuntimeEvent => ({
    _tag: "GraphNodeReleased",
    nodeId,
    reason,
    failure,
    at,
  }),

  graphNodesEvicted: (
    nodeIds: Extract<RuntimeEvent, { readonly _tag: "GraphNodesEvicted" }>["nodeIds"],
    reason: Extract<RuntimeEvent, { readonly _tag: "GraphNodesEvicted" }>["reason"],
    failures: Extract<RuntimeEvent, { readonly _tag: "GraphNodesEvicted" }>["failures"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodesEvicted",
    nodeIds,
    reason,
    failures,
    at,
  }),

  graphNodeCleanupFailed: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeCleanupFailed" }>["nodeId"],
    reason: Extract<RuntimeEvent, { readonly _tag: "GraphNodeCleanupFailed" }>["reason"],
    failures: Extract<RuntimeEvent, { readonly _tag: "GraphNodeCleanupFailed" }>["failures"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeCleanupFailed",
    nodeId,
    reason,
    failures,
    at,
  }),

  graphNodeLiveDemandChanged: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeLiveDemandChanged" }>["nodeId"],
    liveDemand: Extract<
      RuntimeEvent,
      { readonly _tag: "GraphNodeLiveDemandChanged" }
    >["liveDemand"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeLiveDemandChanged",
    nodeId,
    liveDemand,
    at,
  }),

  graphNodeLiveFailed: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeLiveFailed" }>["nodeId"],
    failures: Extract<RuntimeEvent, { readonly _tag: "GraphNodeLiveFailed" }>["failures"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeLiveFailed",
    nodeId,
    failures,
    at,
  }),

  graphNodeResultValidityChanged: (
    nodeId: Extract<RuntimeEvent, { readonly _tag: "GraphNodeResultValidityChanged" }>["nodeId"],
    previous: Extract<
      RuntimeEvent,
      { readonly _tag: "GraphNodeResultValidityChanged" }
    >["previous"],
    next: Extract<RuntimeEvent, { readonly _tag: "GraphNodeResultValidityChanged" }>["next"],
    reason: Extract<RuntimeEvent, { readonly _tag: "GraphNodeResultValidityChanged" }>["reason"],
    at: number
  ): RuntimeEvent => ({
    _tag: "GraphNodeResultValidityChanged",
    nodeId,
    previous,
    next,
    reason,
    at,
  }),
} as const;

export function runtimeEventNodeIds(event: RuntimeEvent): ReadonlyArray<NodeId> {
  return runtimeEventNodeIdsByTag(event);
}

const runtimeEventNodeIdsByTag = Match.type<RuntimeEvent>().pipe(
  Match.tagsExhaustive({
    RuntimeStarted: () => [],
    RuntimeStopped: () => [],
    InputIngestionChanged: () => [],
    RuntimeInputReceived: () => [],
    RuntimeSignalPublished: () => [],
    RuntimeSignalSubscriberFailureObserved: () => [],
    RuntimeSinkFailureObserved: () => [],
    RuntimeObserverFailureObserved: () => [],
    GraphSystemStarted: () => [],
    GraphSystemStopped: () => [],
    GraphSystemInputObserved: () => [],
    GraphNodeEnsured: ({ nodeId }) => [nodeId],
    GraphNodeReadyEnsured: ({ nodeId }) => [nodeId],
    GraphNodeChanged: ({ nodeId }) => [nodeId],
    GraphActionStarted: ({ nodeId }) => [nodeId],
    GraphActionSucceeded: ({ nodeId }) => [nodeId],
    GraphActionFailed: ({ nodeId }) => [nodeId],
    GraphRefreshStarted: ({ nodeId }) => [nodeId],
    GraphRefreshSucceeded: ({ nodeId }) => [nodeId],
    GraphRefreshFailed: ({ nodeId }) => [nodeId],
    GraphNodeArgsUpdateStarted: ({ nodeId }) => [nodeId],
    GraphNodeArgsUpdateSucceeded: ({ nodeId }) => [nodeId],
    GraphNodeArgsUpdateFailed: ({ nodeId }) => [nodeId],
    GraphUnsafeNodeUpdated: ({ nodeId }) => [nodeId],
    GraphUnsafeNodeUpdateFailed: ({ nodeId }) => [nodeId],
    GraphNodeReleased: ({ nodeId }) => [nodeId],
    GraphNodesEvicted: ({ nodeIds }) => nodeIds,
    GraphNodeCleanupFailed: ({ nodeId }) => [nodeId],
    GraphNodeLiveDemandChanged: ({ nodeId }) => [nodeId],
    GraphNodeLiveFailed: ({ nodeId }) => [nodeId],
    GraphNodeResultValidityChanged: ({ nodeId }) => [nodeId],
  })
);

export function runtimeEventNodeId(event: RuntimeEvent): NodeId | undefined {
  return runtimeEventNodeIds(event)[0];
}
