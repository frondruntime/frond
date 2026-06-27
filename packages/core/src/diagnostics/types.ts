export type FrondErrorProjectionKind =
  | "invalid"
  | "live"
  | "operation"
  | "readiness"
  | "runtime"
  | "unexpected";

export type SerializedCauseFrame = {
  readonly index: number;
  readonly valueKind: string;
  readonly name?: string | undefined;
  readonly message?: string | undefined;
  readonly tag?: string | undefined;
  readonly kind?: string | undefined;
  readonly stack?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly nodeTag?: string | undefined;
  readonly operation?: string | undefined;
  readonly dependency?: string | undefined;
  readonly invariant?: string | undefined;
  readonly boundary?: string | undefined;
  readonly cancellation?:
    | {
        readonly _tag?: string | undefined;
        readonly detail?: string | undefined;
      }
    | undefined;
  readonly path?: ReadonlyArray<string> | undefined;
  readonly timeout?: string | undefined;
  readonly preview?: unknown | undefined;
};

export type CauseSerializationOptions = {
  readonly maxDepth?: number | undefined;
  readonly maxStringLength?: number | undefined;
  readonly maxStackLength?: number | undefined;
  readonly maxObjectKeys?: number | undefined;
};

export type NormalizedCauseSerializationOptions = {
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxStackLength: number;
  readonly maxObjectKeys: number;
};

export type FrondErrorProjection = {
  readonly headline: string;
  readonly summary: string;
  readonly kind: FrondErrorProjectionKind;
  readonly retryable: boolean;
  readonly rootTag: string;
  readonly rootMessage: string;
  readonly nodeId?: string | undefined;
  readonly nodeTag?: string | undefined;
  readonly operation?: string | undefined;
  readonly dependency?: string | undefined;
  readonly path?: ReadonlyArray<string> | undefined;
  readonly raw: unknown;
  readonly causeChain: ReadonlyArray<SerializedCauseFrame>;
};

export type FrondErrorReport = {
  readonly error: Error;
  readonly message: string;
  readonly fingerprint: ReadonlyArray<string>;
  readonly tags: Record<string, string>;
  readonly contexts: Record<string, unknown>;
  readonly extra: Record<string, unknown>;
};
