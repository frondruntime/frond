import type { GraphFailure } from "./failures";
import type { NodeId } from "./ids";

export type NodeLiveSource = "mobx" | "manual";

export type NodeLiveScopeKey = string & { readonly __brand: "Graph.NodeLiveScopeKey" };

export type NodeLiveLeaseId = string & { readonly __brand: "Graph.NodeLiveLeaseId" };

export interface NodeLiveDemandSnapshot {
  readonly isLive: boolean;
  readonly sources: ReadonlyArray<NodeLiveSource>;
  readonly scopes: ReadonlyArray<unknown>;
}

export interface ActiveNodeLiveDemandSnapshot extends NodeLiveDemandSnapshot {
  readonly isLive: true;
  readonly sources: readonly [NodeLiveSource, ...NodeLiveSource[]];
  readonly scopes: readonly [unknown, ...unknown[]];
}

export type LiveResourceStopReason =
  | {
      readonly _tag: "DemandInactive";
    }
  | {
      readonly _tag: "DemandChanged";
    }
  | {
      readonly _tag: "UpdateFailed";
    }
  | {
      readonly _tag: "NodeReleased";
    }
  | {
      readonly _tag: "NodeEvicted";
    }
  | {
      readonly _tag: "GraphStopped";
    }
  | {
      readonly _tag: "ReadyInvalidated";
    }
  | {
      // The start operation was interrupted (eviction, stop, or timeout race)
      // but still produced a resource; the runtime routes it into stop instead
      // of dropping it.
      readonly _tag: "StartInterrupted";
    };

export interface NodeLiveFailure {
  readonly failures: ReadonlyArray<GraphFailure>;
  readonly at: number;
}

export interface AcquireNodeLiveLeaseRequest {
  readonly nodeId: NodeId;
  readonly source: NodeLiveSource;
  readonly scope: unknown;
}

export interface ReleaseNodeLiveLeaseRequest {
  readonly nodeId: NodeId;
  readonly leaseId: NodeLiveLeaseId;
}

/**
 * Held means a lease was recorded in the node cell and is releasable by leaseId.
 * Failed means acquisition recorded no lease; liveDemand is the current demand.
 */
export type NodeLiveLeaseResult =
  | NodeLiveLeaseHeldResult
  | NodeLiveLeaseFailedResult
  | NodeLiveLeaseNodeMissingResult;

/**
 * A recorded lease. Delivery failures can coexist with Held when the demand
 * record exists and the lease remains releasable.
 */
export interface NodeLiveLeaseHeldResult {
  readonly _tag: "Held";
  readonly nodeId: NodeId;
  readonly leaseId: NodeLiveLeaseId;
  readonly liveDemand: NodeLiveDemandSnapshot;
  readonly changed: boolean;
  readonly failures: ReadonlyArray<GraphFailure>;
}

/** Acquisition failed before recording a releasable lease. */
export interface NodeLiveLeaseFailedResult {
  readonly _tag: "Failed";
  readonly nodeId: NodeId;
  readonly liveDemand: NodeLiveDemandSnapshot;
  readonly failures: ReadonlyArray<GraphFailure>;
}

export interface NodeLiveLeaseNodeMissingResult {
  readonly _tag: "NodeMissing";
  readonly nodeId: NodeId;
  readonly liveDemand: NodeLiveDemandSnapshot;
}

export type ObservedResultLease =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "Held";
      readonly leaseId: NodeLiveLeaseId;
    };
