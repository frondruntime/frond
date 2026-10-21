import * as Frond from "@frondruntime/core";

export interface FrondReactErrorReport {
  readonly headline: string;
  readonly summary: string;
  readonly message: string;
  readonly kind: Frond.Diagnostics.FrondErrorProjectionKind;
  readonly retryable: boolean;
  readonly causeType: string;
  readonly causeMessage: string;
  readonly failingNode?: Frond.Diagnostics.FrondErrorNodeRef | undefined;
  readonly requester?: Frond.Diagnostics.FrondErrorNodeRef | undefined;
  readonly path: ReadonlyArray<string>;
  /** @deprecated Use `causeType`. */
  readonly rootTag: string;
  /** @deprecated Use `causeMessage`. */
  readonly rootMessage: string;
  /** @deprecated Use `failingNode.id`. */
  readonly nodeId?: string | undefined;
  /** @deprecated Use `failingNode.tag`. */
  readonly nodeTag?: string | undefined;
  readonly operation?: string | undefined;
  readonly dependency?: string | undefined;
  readonly diagnostic: Frond.Diagnostics.FrondErrorReport;
}

/**
 * Builds a display/reporting summary for errors caught by React boundaries.
 *
 * The returned value includes the full Frond diagnostic report for Sentry-like
 * sinks while keeping common UI fields at the top level. Capture
 * `diagnostic.error` plus its fingerprint/tags/contexts/extra; do not report
 * the raw React boundary error if you want graph-aware grouping.
 *
 * `diagnostic` is memoized on the failing node's failure: a boundary error and
 * the runtime report sink resolve to the same report object and the same
 * `diagnostic.error`, so identity-based tracker dedupe skips the second
 * capture.
 */
export function getErrorReport(error: unknown): FrondReactErrorReport {
  const projection = Frond.Diagnostics.projectError(error);
  const diagnostic = Frond.Diagnostics.createErrorReport(error);

  return {
    headline: projection.headline,
    summary: projection.summary,
    message: diagnostic.message,
    kind: projection.kind,
    retryable: projection.retryable,
    causeType: projection.causeType,
    causeMessage: projection.causeMessage,
    failingNode: projection.failingNode,
    requester: projection.requester,
    path: projection.path,
    rootTag: projection.rootTag,
    rootMessage: projection.rootMessage,
    nodeId: projection.nodeId,
    nodeTag: projection.nodeTag,
    operation: projection.operation,
    dependency: projection.dependency,
    diagnostic,
  };
}
