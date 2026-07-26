import type { NodeId } from "../graph";

export type RuntimeReadFailureKind = "readiness" | "invalid" | "runtime";

export class FrondRuntimeReadError extends Error {
  readonly _tag = "FrondRuntimeReadError";

  readonly nodeId: NodeId;

  readonly kind: RuntimeReadFailureKind;

  readonly retryable: boolean;

  override readonly cause: unknown;

  constructor(input: {
    readonly message: string;
    readonly nodeId: NodeId;
    readonly kind: RuntimeReadFailureKind;
    readonly cause: unknown;
  }) {
    super(input.message);
    this.name = "FrondRuntimeReadError";
    this.nodeId = input.nodeId;
    this.kind = input.kind;
    this.retryable = input.kind === "readiness";
    this.cause = input.cause;
  }
}

/**
 * The non-ready readiness phase observed by `handle.readReady()`:
 * `unwired` (node not materialized), `idle` (materialized, no result), or
 * `pending` (readiness attempt in flight).
 */
export type FrondNodeReadiness = "unwired" | "idle" | "pending";

/**
 * Thrown by `handle.readReady()` / `handle.ensureReadyNode()` when the node is
 * not in the `Ready` phase and has no readiness error to rethrow.
 *
 * `tag` is carried when the node's snapshot is reachable; an unwired node that
 * was never materialized reports `undefined`.
 */
export class FrondNodeNotReady extends Error {
  readonly _tag = "FrondNodeNotReady";

  readonly nodeId: NodeId;

  readonly tag: string | undefined;

  readonly readiness: FrondNodeReadiness;

  constructor(input: {
    readonly nodeId: NodeId;
    readonly tag?: string | undefined;
    readonly readiness: FrondNodeReadiness;
    readonly message?: string | undefined;
  }) {
    super(
      input.message ??
        `Frond node ${input.tag ?? input.nodeId} is not ready (${input.readiness}); await ensureReady/ensureReadyNode before reading.`
    );
    this.name = "FrondNodeNotReady";
    this.nodeId = input.nodeId;
    this.tag = input.tag;
    this.readiness = input.readiness;
  }
}

export class FrondRuntimeUnavailable extends Error {
  readonly _tag = "FrondRuntimeUnavailable";

  readonly nodeId: NodeId;

  override readonly cause: unknown;

  constructor(input: {
    readonly message: string;
    readonly nodeId: NodeId;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "FrondRuntimeUnavailable";
    this.nodeId = input.nodeId;
    this.cause = input.cause;
  }
}

export class FrondRuntimeClosed extends Error {
  readonly _tag = "FrondRuntimeClosed";

  readonly operation: string;

  override readonly cause: unknown;

  constructor(input: {
    readonly operation: string;
    readonly message?: string | undefined;
    readonly cause?: unknown;
  }) {
    super(input.message ?? `Frond runtime is stopped; ${input.operation} cannot execute.`);
    this.name = "FrondRuntimeClosed";
    this.operation = input.operation;
    this.cause = input.cause;
  }
}

export class FrondRuntimeInvariantViolation extends Error {
  readonly _tag = "FrondRuntimeInvariantViolation";

  readonly nodeId: NodeId | undefined;

  override readonly cause: unknown;

  constructor(input: {
    readonly message: string;
    readonly nodeId?: NodeId | undefined;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "FrondRuntimeInvariantViolation";
    this.nodeId = input.nodeId;
    this.cause = input.cause;
  }
}
