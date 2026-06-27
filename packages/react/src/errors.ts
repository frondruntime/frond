export class FrondReactUsageError extends Error {
  readonly _tag = "FrondReactUsageError";

  readonly hook: string;

  override readonly cause: unknown;

  constructor(input: {
    readonly hook: string;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "FrondReactUsageError";
    this.hook = input.hook;
    this.cause = input.cause;
  }
}

export class FrondReactAdapterInvariant extends Error {
  readonly _tag = "FrondReactAdapterInvariant";

  readonly hook: string;

  override readonly cause: unknown;

  constructor(input: {
    readonly hook: string;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "FrondReactAdapterInvariant";
    this.hook = input.hook;
    this.cause = input.cause;
  }
}
