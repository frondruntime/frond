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
  /** `ActionFailed.action`. */
  readonly action?: string | undefined;
  /** `LiveDeliveryFailed.stage` (and other staged Frond failures). */
  readonly stage?: string | undefined;
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
  /**
   * Member chains of an aggregate frame (`DependencyFailures`,
   * `DependencyDefinitionFailures`), one serialized chain per member.
   */
  readonly failures?: ReadonlyArray<ReadonlyArray<SerializedCauseFrame>> | undefined;
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

export type FrondErrorNodeRef = {
  readonly id: string;
  readonly tag?: string | undefined;
};

export type FrondErrorProjection = {
  readonly headline: string;
  readonly summary: string;
  readonly kind: FrondErrorProjectionKind;
  readonly retryable: boolean;
  /**
   * What kind of failure: the outermost app error below the failing node's
   * Frond frames (carriers skipped), else the Frond tag the chain ends at,
   * else `Error` (unclassified). Low-cardinality; used for grouping.
   */
  readonly causeType: string;
  /** What happened: the deepest meaningful app or carrier message. May be empty. */
  readonly causeMessage: string;
  /** Type of the frame that supplied `causeMessage`, when one did. */
  readonly messageType?: string | undefined;
  /** Stack of the frame that supplied the message, else of the cause-type frame. */
  readonly stack?: string | undefined;
  /** Where: the deepest Frond frame carrying both a node id and a tag. */
  readonly failingNode?: FrondErrorNodeRef | undefined;
  /** The outermost node of the chain (the reader or the event's node). */
  readonly requester?: FrondErrorNodeRef | undefined;
  /** Node tags from requester down to the failing node, deduplicated. */
  readonly path: ReadonlyArray<string>;
  readonly operation?: string | undefined;
  readonly dependency?: string | undefined;
  /**
   * The failing node's own failure object: the outermost raw frame of its
   * contiguous Frond frames. Reports memoize on it, and the tracker-facing
   * error uses it as `cause`.
   */
  readonly failingFailure: unknown;
  /** @deprecated Use `causeType`. */
  readonly rootTag: string;
  /** @deprecated Use `causeMessage`. */
  readonly rootMessage: string;
  /** @deprecated Use `failingNode.id`. */
  readonly nodeId?: string | undefined;
  /** @deprecated Use `failingNode.tag`. */
  readonly nodeTag?: string | undefined;
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
