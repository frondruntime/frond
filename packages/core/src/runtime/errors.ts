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
