import type { NodeLiveDemandSnapshot, NodeLiveLeaseId } from "../../graph/types/liveness";
import type {
  ActionResult,
  EvictResult,
  RefreshResult,
  UnsafeUpdateNodeResult,
  UpdateNodeArgsResult,
} from "../../graph/types/operations";
import type { NodeRead } from "../../graph/types/reads";

export type RuntimeSubmission =
  | {
      readonly _tag: "RuntimeStarted";
    }
  | {
      readonly _tag: "RuntimeStopped";
    }
  | {
      readonly _tag: "GraphNodeEnsured";
      readonly read: NodeRead;
    }
  | {
      readonly _tag: "GraphNodeReadyEnsured";
      readonly read: NodeRead;
    }
  | {
      readonly _tag: "GraphActionCompleted";
      readonly result: ActionResult;
    }
  | {
      readonly _tag: "GraphRefreshCompleted";
      readonly result: RefreshResult;
    }
  | {
      readonly _tag: "GraphNodeArgsUpdateCompleted";
      readonly result: UpdateNodeArgsResult;
    }
  | {
      readonly _tag: "GraphUnsafeNodeUpdateCompleted";
      readonly result: UnsafeUpdateNodeResult;
    }
  | {
      readonly _tag: "GraphNodeReleased";
      readonly nodeId: NodeRead["nodeId"];
    }
  | {
      readonly _tag: "GraphSubgraphEvicted";
      readonly result: EvictResult;
    }
  | {
      readonly _tag: "GraphNodeLiveLeaseAcquired";
      readonly nodeId: NodeRead["nodeId"];
      readonly leaseId: NodeLiveLeaseId;
      readonly liveDemand: NodeLiveDemandSnapshot;
    }
  | {
      readonly _tag: "GraphNodeLiveLeaseReleased";
      readonly nodeId: NodeRead["nodeId"];
      readonly leaseId: NodeLiveLeaseId;
      readonly liveDemand: NodeLiveDemandSnapshot;
    };
