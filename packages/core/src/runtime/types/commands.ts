import type {
  AcquireNodeLiveLeaseRequest,
  ReleaseNodeLiveLeaseRequest,
} from "../../graph/types/liveness";
import type {
  ActionRequest,
  EvictSubgraphRequest,
  NodeRequest,
  RefreshRequest,
  UnsafeUpdateNodeRequest,
  UpdateNodeArgsRequest,
} from "../../graph/types/operations";
import type { NodeRead } from "../../graph/types/reads";
import type { RuntimeSignal } from "../../signals";
import type { RuntimeWorkMetadata } from "../work";

type WithRuntimeWorkMetadata<T> = T & {
  readonly metadata?: RuntimeWorkMetadata | undefined;
};

export type RuntimeCommand = WithRuntimeWorkMetadata<
  | {
      readonly _tag: "RuntimeStart";
    }
  | {
      readonly _tag: "RuntimeStop";
      readonly reason?: string | undefined;
    }
  | {
      readonly _tag: "GraphEnsureNode";
      readonly request: NodeRequest;
    }
  | {
      readonly _tag: "GraphEnsureReadyNode";
      readonly request: NodeRequest;
    }
  | {
      readonly _tag: "GraphEnsureReadyNodeById";
      readonly nodeId: NodeRead["nodeId"];
    }
  | {
      readonly _tag: "GraphRunAction";
      readonly request: ActionRequest;
    }
  | {
      readonly _tag: "GraphRefreshNode";
      readonly request: RefreshRequest;
    }
  | {
      readonly _tag: "GraphUpdateNodeArgs";
      readonly request: UpdateNodeArgsRequest;
    }
  | {
      readonly _tag: "GraphUnsafeUpdateNode";
      readonly request: UnsafeUpdateNodeRequest;
    }
  | {
      readonly _tag: "GraphReleaseNode";
      readonly nodeId: NodeRead["nodeId"];
      readonly reason?: string | undefined;
    }
  | {
      readonly _tag: "GraphEvictSubgraph";
      readonly request: EvictSubgraphRequest;
    }
  | {
      readonly _tag: "GraphAcquireNodeLiveLease";
      readonly request: AcquireNodeLiveLeaseRequest;
    }
  | {
      readonly _tag: "GraphReleaseNodeLiveLease";
      readonly request: ReleaseNodeLiveLeaseRequest;
    }
>;

export type RuntimeControl = WithRuntimeWorkMetadata<{
  readonly _tag: "SetInputIngestion";
  readonly enabled: boolean;
}>;

export type RuntimeQuery =
  | {
      readonly _tag: "RuntimeStatus";
    }
  | {
      readonly _tag: "RuntimeEvents";
      readonly limit?: number | undefined;
    }
  | {
      readonly _tag: "RuntimeSinks";
    }
  | {
      readonly _tag: "RuntimeSignals";
      readonly channel?: RuntimeSignal["channel"] | undefined;
      readonly limit?: number | undefined;
    }
  | {
      readonly _tag: "RuntimeSignalSubscribers";
    };

export type RuntimeInput = {
  readonly _tag: "RuntimeInput";
  readonly name: string;
  readonly payload: unknown;
  readonly metadata?: RuntimeWorkMetadata | undefined;
};
