import * as Frond from "@frondruntime/core";

export interface FrondReactErrorReport {
  readonly headline: string;
  readonly summary: string;
  readonly message: string;
  readonly kind: Frond.Diagnostics.FrondErrorProjectionKind;
  readonly retryable: boolean;
  readonly rootTag: string;
  readonly rootMessage: string;
  readonly nodeId?: string | undefined;
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
    rootTag: projection.rootTag,
    rootMessage: projection.rootMessage,
    nodeId: projection.nodeId,
    nodeTag: projection.nodeTag,
    operation: projection.operation,
    dependency: projection.dependency,
    diagnostic,
  };
}
