import { Data } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type { NodeId } from "./ids";
import type { ResultValidity } from "./resultValidity";

export class AcquireFailed extends Data.TaggedError("AcquireFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {}

export class EffectBoundaryFailed extends Data.TaggedError("EffectBoundaryFailed")<{
  readonly boundary: string;
  readonly cause: unknown;
  readonly effectCause: unknown;
  readonly pretty: string;
}> {}

export class DependencyFailed extends Data.TaggedError("DependencyFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly dependency: string;
  readonly dependencyNodeId: NodeId;
  readonly cause: unknown;
}> {}

export class DependencyFailures extends Data.TaggedError("DependencyFailures")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly failures: readonly [DependencyFailed, ...DependencyFailed[]];
}> {}

export class DependencyResultExpired extends Data.TaggedError("DependencyResultExpired")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>;
}> {}

export class DependencyRefreshFailed extends Data.TaggedError("DependencyRefreshFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly dependency: string;
  readonly dependencyNodeId: NodeId;
  readonly cause: unknown;
}> {}

export class DriverPromiseFailed extends Data.TaggedError("DriverPromiseFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class DriverOperationTimedOut extends Data.TaggedError("DriverOperationTimedOut")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly operation: string;
  readonly timeout: number;
  readonly cancellation: RuntimeCancellationReason;
}> {}

export class DisposerFailed extends Data.TaggedError("DisposerFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {}

export class LiveDeliveryFailed extends Data.TaggedError("LiveDeliveryFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly stage: "start" | "update" | "stop";
  readonly cause: unknown;
}> {}

export class NodeEvicted extends Data.TaggedError("NodeEvicted")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cancellation: RuntimeCancellationReason;
  readonly reason?: string | undefined;
}> {}

export class CycleDetected extends Data.TaggedError("CycleDetected")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly path: ReadonlyArray<NodeId>;
}> {}

export class KeyBuildFailed extends Data.TaggedError("KeyBuildFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {}

export class DependencyDefinitionFailed extends Data.TaggedError("DependencyDefinitionFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly dependency?: string | undefined;
  readonly cause: unknown;
}> {}

export class DependencyDefinitionFailures extends Data.TaggedError("DependencyDefinitionFailures")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly failures: readonly [DependencyDefinitionFailed, ...DependencyDefinitionFailed[]];
}> {}

export class NodeConstructionFailed extends Data.TaggedError("NodeConstructionFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {}

export class DuplicateNodeTag extends Data.TaggedError("DuplicateNodeTag")<{
  readonly nodeId: NodeId;
  readonly tag: string;
}> {}

export class ActionFailed extends Data.TaggedError("ActionFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly action: string;
  readonly input: unknown;
  readonly cause: unknown;
}> {}

export class RefreshFailed extends Data.TaggedError("RefreshFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {}

export class ResultExpired extends Data.TaggedError("ResultExpired")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>;
}> {}

export class UpdateNodeArgsFailed extends Data.TaggedError("UpdateNodeArgsFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {}

export class UnsafeUpdateNodeFailed extends Data.TaggedError("UnsafeUpdateNodeFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly label?: string | undefined;
  readonly cause: unknown;
}> {}

export class GraphInvariantViolation extends Data.TaggedError("GraphInvariantViolation")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly invariant: string;
  readonly cause?: unknown;
}> {}

export class GraphConfigInvalid extends Data.TaggedError("GraphConfigInvalid")<{
  readonly field: string;
  readonly cause: unknown;
}> {}

export class SpecOverrideFailed extends Data.TaggedError("SpecOverrideFailed")<{
  readonly reason: "duplicate-original" | "tag-mismatch" | "cycle";
  readonly cause?: unknown;
}> {}

export type GraphFailure =
  | AcquireFailed
  | EffectBoundaryFailed
  | DependencyFailed
  | DependencyFailures
  | DependencyResultExpired
  | DependencyRefreshFailed
  | ResultExpired
  | DriverPromiseFailed
  | DriverOperationTimedOut
  | DisposerFailed
  | LiveDeliveryFailed
  | NodeEvicted
  | CycleDetected
  | KeyBuildFailed
  | DependencyDefinitionFailed
  | DependencyDefinitionFailures
  | NodeConstructionFailed
  | DuplicateNodeTag
  | ActionFailed
  | RefreshFailed
  | UpdateNodeArgsFailed
  | UnsafeUpdateNodeFailed
  | GraphConfigInvalid
  | GraphInvariantViolation
  | SpecOverrideFailed;
