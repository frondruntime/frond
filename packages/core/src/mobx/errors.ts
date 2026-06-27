import type { NodeId } from "../graph";

export class FrondMobXProjectionError extends Error {
  readonly _tag = "FrondMobXProjectionError";

  readonly nodeId: NodeId;

  override readonly cause: unknown;

  constructor(input: {
    readonly nodeId: NodeId;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "FrondMobXProjectionError";
    this.nodeId = input.nodeId;
    this.cause = input.cause;
  }
}
