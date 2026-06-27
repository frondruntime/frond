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

export interface NodeLiveLeaseResult {
  readonly nodeId: NodeId;
  readonly leaseId: NodeLiveLeaseId;
  readonly liveDemand: NodeLiveDemandSnapshot;
  readonly changed: boolean;
  readonly failures: ReadonlyArray<GraphFailure>;
}

export type ObservedResultLease =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "Held";
      readonly leaseId: NodeLiveLeaseId;
    };
