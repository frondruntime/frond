/**
 * Failures a readiness attempt reported at its source (`GraphNodeReadinessFailed`).
 *
 * Keyed by identity: a dependent's `DependencyFailed` wraps the same object the
 * dependency's attempt failed with, so event classification can tell a wrapper
 * of an already-reported failure from one that wraps something never reported
 * (an invariant violation, an expired result, a planning failure).
 */
const sourceFailures = new WeakSet<object>();

export function recordSourceFailure(failure: unknown): void {
  if (typeof failure === "object" && failure !== null) {
    sourceFailures.add(failure);
  }
}

export function isSourceFailure(failure: unknown): boolean {
  return typeof failure === "object" && failure !== null && sourceFailures.has(failure);
}
