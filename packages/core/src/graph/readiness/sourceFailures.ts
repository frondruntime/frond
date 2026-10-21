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

/**
 * True when the failure is the node failing *because of* dependencies whose
 * own attempts already reported the cause: the failure itself, or its direct
 * cause, is a `DependencyFailed(s)` wrapper and every wrapped cause is a
 * source-reported failure. A wrapper of anything else (an invariant
 * violation, an expired result, a planning failure) was never reported and
 * stays reportable here.
 */
export function wrapsReportedDependency(error: unknown): boolean {
  return isReportedDependencyWrapper(error) || isReportedDependencyWrapper(readCause(error));
}

/**
 * The failures of a value that no attempt reported: the value itself, or, when
 * it is (or directly wraps) a `DependencyFailures` aggregate, the members that
 * do not wrap a source-reported failure. A mixed aggregate thus reports each
 * unreported member once and none of the reported ones again.
 */
export function unreportedFailures(error: unknown): ReadonlyArray<unknown> {
  const members = aggregateMembers(error) ?? aggregateMembers(readCause(error));

  if (members === undefined) {
    return [error];
  }

  return members.filter((member) => !isReportedDependencyWrapper(member));
}

function isReportedDependencyWrapper(
  value: unknown,
  visited: WeakSet<object> = new WeakSet()
): boolean {
  // Guard: a cyclic cause chain is not a reported dependency wrapper.
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return false;
  }

  visited.add(value);
  const tag = readField(value, "_tag");

  if (tag === "DependencyFailed") {
    const cause = readCause(value);
    return isSourceFailure(cause) || isReportedDependencyWrapper(cause, visited);
  }

  const members = aggregateMembers(value);

  return (
    members !== undefined &&
    members.length > 0 &&
    members.every((member) => isReportedDependencyWrapper(member, visited))
  );
}

function aggregateMembers(value: unknown): ReadonlyArray<unknown> | undefined {
  if (readField(value, "_tag") !== "DependencyFailures") {
    return undefined;
  }

  const failures = readField(value, "failures");

  return Array.isArray(failures) ? failures : undefined;
}

function readCause(value: unknown): unknown {
  return readField(value, "cause");
}

function readField(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null && field in value
    ? (value as Record<string, unknown>)[field]
    : undefined;
}
