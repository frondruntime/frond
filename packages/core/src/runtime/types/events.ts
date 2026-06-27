import type { RuntimeEventClassification } from "../../events";
import type { GraphFailure } from "../../graph/types/failures";
import type { NodeLiveDemandSnapshot } from "../../graph/types/liveness";
import type {
  ActionResult,
  RefreshResult,
  UnsafeUpdateNodeResult,
  UpdateNodeArgsResult,
} from "../../graph/types/operations";
import type { NodeRead } from "../../graph/types/reads";
import type { ResultValidity, ResultValidityChangedReason } from "../../graph/types/resultValidity";
import type { GraphCleanupFailureReason } from "../../graph/types/subscriptions";
import type { RuntimeSignalRecord } from "../../signals";
import type { RuntimeWorkContext } from "../work";
import type { RuntimeInput } from "./commands";
import type { RuntimeId } from "./ids";

export type RuntimeEvent =
  | {
      readonly _tag: "RuntimeStarted";
      readonly at: number;
    }
  | {
      readonly _tag: "RuntimeStopped";
      readonly at: number;
      readonly reason?: string | undefined;
    }
  | {
      readonly _tag: "InputIngestionChanged";
      readonly enabled: boolean;
      readonly at: number;
    }
  | {
      readonly _tag: "RuntimeInputReceived";
      readonly input: RuntimeInput;
      readonly at: number;
    }
  | {
      readonly _tag: "RuntimeSignalPublished";
      readonly record: RuntimeSignalRecord;
      readonly at: number;
    }
  | {
      readonly _tag: "RuntimeSignalSubscriberFailureObserved";
      readonly subscriber: string;
      readonly signal: RuntimeSignalRecord;
      readonly cause: unknown;
      readonly at: number;
    }
  | {
      readonly _tag: "RuntimeSinkFailureObserved";
      readonly sink: string;
      readonly eventTag: RuntimeEvent["_tag"];
      readonly cause: unknown;
      readonly at: number;
    }
  | {
      readonly _tag: "RuntimeObserverFailureObserved";
      readonly eventTag: RuntimeEvent["_tag"];
      readonly cause: unknown;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphSystemStarted";
      readonly at: number;
    }
  | {
      readonly _tag: "GraphSystemStopped";
      readonly at: number;
    }
  | {
      readonly _tag: "GraphSystemInputObserved";
      readonly inputTag: RuntimeInput["_tag"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeEnsured";
      readonly nodeId: NodeRead["nodeId"];
      readonly status: NodeRead["status"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeReadyEnsured";
      readonly nodeId: NodeRead["nodeId"];
      readonly status: NodeRead["status"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeChanged";
      readonly nodeId: NodeRead["nodeId"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphActionStarted";
      readonly nodeId: NodeRead["nodeId"];
      readonly action: string;
      readonly input: unknown;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphActionSucceeded";
      readonly nodeId: NodeRead["nodeId"];
      readonly action: string;
      readonly input: unknown;
      readonly value: unknown;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphActionFailed";
      readonly nodeId: NodeRead["nodeId"];
      readonly action: string;
      readonly input: unknown;
      readonly error: Extract<ActionResult, { readonly _tag: "Failure" }>["error"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphRefreshStarted";
      readonly nodeId: NodeRead["nodeId"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphRefreshSucceeded";
      readonly nodeId: NodeRead["nodeId"];
      readonly value: unknown;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphRefreshFailed";
      readonly nodeId: NodeRead["nodeId"];
      readonly error: Extract<RefreshResult, { readonly _tag: "Failure" }>["error"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeArgsUpdateStarted";
      readonly nodeId: NodeRead["nodeId"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeArgsUpdateSucceeded";
      readonly nodeId: NodeRead["nodeId"];
      readonly shouldRefresh: boolean;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeArgsUpdateFailed";
      readonly nodeId: NodeRead["nodeId"];
      readonly error: Extract<UpdateNodeArgsResult, { readonly _tag: "Failure" }>["error"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphUnsafeNodeUpdated";
      readonly nodeId: NodeRead["nodeId"];
      readonly label?: string | undefined;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphUnsafeNodeUpdateFailed";
      readonly nodeId: NodeRead["nodeId"];
      readonly label?: string | undefined;
      readonly error: Extract<UnsafeUpdateNodeResult, { readonly _tag: "Failure" }>["error"];
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeReleased";
      readonly nodeId: NodeRead["nodeId"];
      readonly reason?: string | undefined;
      readonly failure?: GraphFailure | undefined;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodesEvicted";
      readonly nodeIds: ReadonlyArray<NodeRead["nodeId"]>;
      readonly reason?: string | undefined;
      readonly failures: ReadonlyArray<GraphFailure>;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeCleanupFailed";
      readonly nodeId: NodeRead["nodeId"];
      readonly reason: GraphCleanupFailureReason | "runtime-stop";
      readonly failures: ReadonlyArray<GraphFailure>;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeLiveDemandChanged";
      readonly nodeId: NodeRead["nodeId"];
      readonly liveDemand: NodeLiveDemandSnapshot;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeLiveFailed";
      readonly nodeId: NodeRead["nodeId"];
      readonly failures: ReadonlyArray<GraphFailure>;
      readonly at: number;
    }
  | {
      readonly _tag: "GraphNodeResultValidityChanged";
      readonly nodeId: NodeRead["nodeId"];
      readonly previous: ResultValidity;
      readonly next: ResultValidity;
      readonly reason: ResultValidityChangedReason;
      readonly at: number;
    };

export type RuntimeEventRecord = {
  readonly runtimeId: RuntimeId;
  readonly sequence: number;
  readonly recordedAt: number;
  readonly work: RuntimeWorkContext;
  readonly event: RuntimeEvent;
  readonly classification: RuntimeEventClassification;
  readonly nodeIds: ReadonlyArray<NodeRead["nodeId"]>;
  readonly failures: ReadonlyArray<unknown>;
};
