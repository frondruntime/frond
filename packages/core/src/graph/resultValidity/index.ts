import { Duration, Match } from "effect";
import {
  GraphInvariantViolation,
  type NodeId,
  type NormalizedResultValidityPolicy,
  type ResultCommit,
  ResultCommitTag,
  type ResultValidity,
  type ResultValidityChangedReason,
  type ResultValidityPolicy,
} from "../types";

export interface ResultState {
  readonly result: unknown;
  readonly resultValidity: ResultValidity;
  readonly resultLoadedAt?: number | undefined;
  readonly resultValidityCommit: "default" | "explicit";
}

export interface ResultValidityContext {
  readonly nodeId: NodeId;
  readonly tag: string;
}

export type ResultCommitDefaultValidity = "current" | "preserve";

export interface ResultCommitOptions {
  readonly context: ResultValidityContext;
  readonly defaultLoadedAt?: number | undefined;
  readonly defaultValidity?: ResultCommitDefaultValidity | undefined;
}

export const staticResultValidityPolicy: NormalizedResultValidityPolicy = { _tag: "Static" };

export function currentResultValidity(currentAt?: number | undefined): ResultValidity {
  return currentAt === undefined ? { _tag: "Current" } : { _tag: "Current", currentAt };
}

export function normalizeResultValidityPolicy(
  policy: ResultValidityPolicy | undefined,
  context: ResultValidityContext
): NormalizedResultValidityPolicy {
  if (policy === undefined) {
    return staticResultValidityPolicy;
  }

  return Match.value(policy).pipe(
    Match.tag("Static", () => staticResultValidityPolicy),
    Match.tag("Manual", () => ({ _tag: "Manual" }) as const),
    Match.tag("TimeBound", ({ staleAfter, expireAfter }) =>
      normalizeTimeBoundPolicy(staleAfter, expireAfter, context)
    ),
    Match.exhaustive
  );
}

export function commitResultState(
  next: unknown,
  previous: ResultState | undefined,
  policy: NormalizedResultValidityPolicy,
  now: number,
  options: ResultCommitOptions
): ResultState {
  const defaultLoadedAt = options.defaultLoadedAt ?? now;
  const defaultValidity = options.defaultValidity ?? "current";

  if (isResultCommit(next)) {
    const hasExplicitMetadata = next.validity !== undefined || next.loadedAt !== undefined;
    const loadedAt = validateLoadedAt(
      next.loadedAt ?? previous?.resultLoadedAt ?? defaultLoadedAt,
      options.context
    );
    const validity = validateResultValidity(
      next.validity ?? currentResultValidity(loadedAt),
      options.context
    );

    return {
      result: next.result,
      resultLoadedAt: loadedAt,
      resultValidity: effectiveResultValidity(validity, policy, loadedAt, now),
      resultValidityCommit: hasExplicitMetadata ? "explicit" : "default",
    };
  }

  const loadedAt =
    defaultValidity === "preserve"
      ? (previous?.resultLoadedAt ?? defaultLoadedAt)
      : defaultLoadedAt;
  const validity =
    defaultValidity === "preserve"
      ? (previous?.resultValidity ?? currentResultValidity(loadedAt))
      : currentResultValidity(loadedAt);

  return {
    result: next,
    resultLoadedAt: validateLoadedAt(loadedAt, options.context),
    resultValidity: effectiveResultValidity(validity, policy, loadedAt, now),
    resultValidityCommit:
      defaultValidity === "preserve" ? (previous?.resultValidityCommit ?? "default") : "default",
  };
}

export function effectiveResultValidity(
  stored: ResultValidity,
  policy: NormalizedResultValidityPolicy,
  loadedAt: number | undefined,
  now: number
): ResultValidity {
  if (policy._tag !== "TimeBound" || loadedAt === undefined) {
    return stored;
  }

  const age = now - loadedAt;

  if (policy.expireAfterMillis !== undefined && age >= policy.expireAfterMillis) {
    return { _tag: "Expired", expiredAt: loadedAt + policy.expireAfterMillis };
  }

  if (policy.staleAfterMillis !== undefined && age >= policy.staleAfterMillis) {
    return { _tag: "Stale", staleAt: loadedAt + policy.staleAfterMillis };
  }

  return currentResultValidity(loadedAt);
}

export function validityChanged(left: ResultValidity, right: ResultValidity): boolean {
  return left._tag !== right._tag || validityAt(left) !== validityAt(right);
}

export function resultValiditySpanAttributes(input: {
  readonly previous?: ResultValidity | undefined;
  readonly next?: ResultValidity | undefined;
  readonly reason?: ResultValidityChangedReason | undefined;
}): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};

  if (input.previous !== undefined) {
    attributes["frond.result.validity.previous"] = input.previous._tag;
  }

  if (input.next !== undefined) {
    attributes["frond.result.validity.next"] = input.next._tag;
  }

  if (input.reason !== undefined) {
    attributes["frond.result.validity.reason"] = input.reason;
  }

  return attributes;
}

function normalizeTimeBoundPolicy(
  staleAfter: Duration.Input | undefined,
  expireAfter: Duration.Input | undefined,
  context: ResultValidityContext
): NormalizedResultValidityPolicy {
  const staleAfterMillis =
    staleAfter === undefined ? undefined : decodeDurationMillis(staleAfter, "staleAfter", context);
  const expireAfterMillis =
    expireAfter === undefined
      ? undefined
      : decodeDurationMillis(expireAfter, "expireAfter", context);

  if (
    staleAfterMillis !== undefined &&
    expireAfterMillis !== undefined &&
    expireAfterMillis < staleAfterMillis
  ) {
    throw new GraphInvariantViolation({
      nodeId: context.nodeId,
      tag: context.tag,
      invariant: "result validity expireAfter must be greater than or equal to staleAfter",
      cause: { staleAfter, expireAfter },
    });
  }

  return { _tag: "TimeBound", staleAfterMillis, expireAfterMillis };
}

function decodeDurationMillis(
  value: Duration.Input,
  field: "staleAfter" | "expireAfter",
  context: ResultValidityContext
): number {
  let millis: number;

  try {
    millis = Duration.toMillis(Duration.fromInputUnsafe(value));
  } catch (cause) {
    throw invalidDurationFailure(value, field, context, cause);
  }

  if (!Number.isFinite(millis) || millis < 0) {
    throw invalidDurationFailure(value, field, context);
  }

  return millis;
}

function invalidDurationFailure(
  value: Duration.Input,
  field: "staleAfter" | "expireAfter",
  context: ResultValidityContext,
  cause?: unknown
): GraphInvariantViolation {
  return new GraphInvariantViolation({
    nodeId: context.nodeId,
    tag: context.tag,
    invariant: `result validity ${field} must be a finite non-negative duration`,
    cause: cause === undefined ? { value } : { value, cause },
  });
}

function isResultCommit(value: unknown): value is ResultCommit<unknown> {
  return typeof value === "object" && value !== null && ResultCommitTag in value;
}

function validateLoadedAt(value: unknown, context: ResultValidityContext): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  throw new GraphInvariantViolation({
    nodeId: context.nodeId,
    tag: context.tag,
    invariant: "result commit loadedAt must be a finite non-negative number",
    cause: { loadedAt: value },
  });
}

export function validateResultValidity(
  value: unknown,
  context: ResultValidityContext
): ResultValidity {
  if (typeof value !== "object" || value === null || !("_tag" in value)) {
    throw invalidResultValidity(value, context);
  }
  const tagged = value as {
    readonly _tag?: unknown;
    readonly currentAt?: unknown;
    readonly staleAt?: unknown;
    readonly expiredAt?: unknown;
  };

  return Match.value(tagged._tag).pipe(
    Match.when(
      "Current",
      () =>
        ({
          _tag: "Current",
          currentAt:
            tagged.currentAt === undefined
              ? undefined
              : validateValidityAt(tagged.currentAt, "currentAt", context),
        }) satisfies ResultValidity
    ),
    Match.when(
      "Stale",
      () =>
        ({
          _tag: "Stale",
          staleAt: validateValidityAt(tagged.staleAt, "staleAt", context),
        }) satisfies ResultValidity
    ),
    Match.when(
      "Expired",
      () =>
        ({
          _tag: "Expired",
          expiredAt: validateValidityAt(tagged.expiredAt, "expiredAt", context),
        }) satisfies ResultValidity
    ),
    Match.orElse(() => {
      throw invalidResultValidity(value, context);
    })
  );
}

export function resultValidityInvariantFailure(
  context: ResultValidityContext,
  invariant: string,
  cause: unknown
): GraphInvariantViolation {
  return cause instanceof GraphInvariantViolation
    ? cause
    : new GraphInvariantViolation({
        nodeId: context.nodeId,
        tag: context.tag,
        invariant,
        cause,
      });
}

function validateValidityAt(
  value: unknown,
  field: "currentAt" | "staleAt" | "expiredAt",
  context: ResultValidityContext
): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  throw new GraphInvariantViolation({
    nodeId: context.nodeId,
    tag: context.tag,
    invariant: `result validity ${field} must be a finite non-negative number`,
    cause: { [field]: value },
  });
}

function invalidResultValidity(
  value: unknown,
  context: ResultValidityContext
): GraphInvariantViolation {
  return new GraphInvariantViolation({
    nodeId: context.nodeId,
    tag: context.tag,
    invariant: "result commit validity must be Current, Stale, or Expired",
    cause: { validity: value },
  });
}

function validityAt(validity: ResultValidity): number | undefined {
  return Match.value(validity).pipe(
    Match.tag("Current", ({ currentAt }) => currentAt),
    Match.tag("Stale", ({ staleAt }) => staleAt),
    Match.tag("Expired", ({ expiredAt }) => expiredAt),
    Match.exhaustive
  );
}
