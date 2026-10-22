import { Data } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type { NodeId } from "./ids";
import type { ResultValidity } from "./resultValidity";

// Every failure carries a computed `message` (`<node tag>: <what failed>`):
// `Data.TaggedError` leaves it empty, and generic trackers show the cause
// list by message.

export class AcquireFailed extends Data.TaggedError("AcquireFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: acquire failed`;
  }
}

export class EffectBoundaryFailed extends Data.TaggedError("EffectBoundaryFailed")<{
  readonly boundary: string;
  readonly cause: unknown;
  readonly effectCause: unknown;
  readonly pretty: string;
}> {
  override get message(): string {
    return `${this.boundary}: effect failed`;
  }
}

export class DependencyFailed extends Data.TaggedError("DependencyFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly dependency: string;
  readonly dependencyNodeId: NodeId;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: dependency ${this.dependency} failed`;
  }
}

export class DependencyFailures extends Data.TaggedError("DependencyFailures")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly failures: readonly [DependencyFailed, ...DependencyFailed[]];
}> {
  override get message(): string {
    return `${this.tag}: ${this.failures.length} dependencies failed (${this.failures.map((failure) => failure.dependency).join(", ")})`;
  }
}

export class DependencyResultExpired extends Data.TaggedError("DependencyResultExpired")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>;
}> {
  override get message(): string {
    return `${this.tag}: dependency result expired`;
  }
}

export class DependencyRefreshFailed extends Data.TaggedError("DependencyRefreshFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly dependency: string;
  readonly dependencyNodeId: NodeId;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: dependency ${this.dependency} refresh failed`;
  }
}

export class DriverPromiseFailed extends Data.TaggedError("DriverPromiseFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: ${this.operation} promise rejected`;
  }
}

export class DriverOperationTimedOut extends Data.TaggedError("DriverOperationTimedOut")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly operation: string;
  readonly timeout: number;
  readonly cancellation: RuntimeCancellationReason;
}> {
  override get message(): string {
    return `${this.tag}: ${this.operation} timed out after ${this.timeout}ms`;
  }
}

export class DisposerFailed extends Data.TaggedError("DisposerFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: disposer failed`;
  }
}

// Structured cause for an async disposer that outlived its per-disposer
// `driverTimeouts.release` bound. Always surfaces wrapped as the `cause` of a
// `DisposerFailed` (never a `ReleaseFailed` — a disposer that timed out is not
// a failed release hook), so it is not part of the `GraphFailure` union.
export class DisposerTimedOut extends Data.TaggedError("DisposerTimedOut")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly timeout: number;
  readonly cancellation: RuntimeCancellationReason;
}> {
  override get message(): string {
    return `${this.tag}: disposer timed out after ${this.timeout}ms`;
  }
}

export class ReleaseFailed extends Data.TaggedError("ReleaseFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: release failed`;
  }
}

export class LiveDeliveryFailed extends Data.TaggedError("LiveDeliveryFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly stage: "start" | "update" | "stop";
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: live ${this.stage} failed`;
  }
}

export class NodeEvicted extends Data.TaggedError("NodeEvicted")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cancellation: RuntimeCancellationReason;
  readonly reason?: string | undefined;
}> {
  override get message(): string {
    return this.reason === undefined
      ? `${this.tag}: node evicted`
      : `${this.tag}: node evicted (${this.reason})`;
  }
}

export class CycleDetected extends Data.TaggedError("CycleDetected")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly path: ReadonlyArray<NodeId>;
}> {
  override get message(): string {
    return `${this.tag}: dependency cycle detected`;
  }
}

export class KeyBuildFailed extends Data.TaggedError("KeyBuildFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: key build failed`;
  }
}

export class DependencyDefinitionFailed extends Data.TaggedError("DependencyDefinitionFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly dependency?: string | undefined;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.dependency === undefined
      ? `${this.tag}: dependency definition failed`
      : `${this.tag}: dependency ${this.dependency} definition failed`;
  }
}

export class DependencyDefinitionFailures extends Data.TaggedError("DependencyDefinitionFailures")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly failures: readonly [DependencyDefinitionFailed, ...DependencyDefinitionFailed[]];
}> {
  override get message(): string {
    return `${this.tag}: ${this.failures.length} dependency definitions failed`;
  }
}

export class NodeConstructionFailed extends Data.TaggedError("NodeConstructionFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: node construction failed`;
  }
}

export class DuplicateNodeTag extends Data.TaggedError("DuplicateNodeTag")<{
  readonly nodeId: NodeId;
  readonly tag: string;
}> {
  override get message(): string {
    return `${this.tag}: duplicate node tag`;
  }
}

export class ActionFailed extends Data.TaggedError("ActionFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly action: string;
  readonly input: unknown;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: action ${this.action} failed`;
  }
}

export class RefreshFailed extends Data.TaggedError("RefreshFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: refresh failed`;
  }
}

export class ResultExpired extends Data.TaggedError("ResultExpired")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>;
}> {
  override get message(): string {
    return `${this.tag}: result expired`;
  }
}

export class UpdateNodeArgsFailed extends Data.TaggedError("UpdateNodeArgsFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.tag}: args update failed`;
  }
}

export class UnsafeUpdateNodeFailed extends Data.TaggedError("UnsafeUpdateNodeFailed")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly label?: string | undefined;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.label === undefined
      ? `${this.tag}: unsafe update failed`
      : `${this.tag}: unsafe update ${this.label} failed`;
  }
}

export class GraphInvariantViolation extends Data.TaggedError("GraphInvariantViolation")<{
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly invariant: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.tag}: invariant violated: ${this.invariant}`;
  }
}

export class GraphConfigInvalid extends Data.TaggedError("GraphConfigInvalid")<{
  readonly field: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `graph config invalid: ${this.field}`;
  }
}

export class SpecOverrideFailed extends Data.TaggedError("SpecOverrideFailed")<{
  readonly reason: "duplicate-original" | "tag-mismatch" | "cycle";
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `spec override failed: ${this.reason}`;
  }
}

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
  | ReleaseFailed
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
