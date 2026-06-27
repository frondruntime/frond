import { Cause } from "effect";
import { EffectBoundaryFailed } from "../types";

export type EffectBoundary =
  | "driver-action"
  | "driver-live"
  | "driver-refresh"
  | "driver-release"
  | "readiness-acquire"
  | "runtime-signal-subscriber"
  | "runtime-sink";

export function effectBoundaryFailed(
  boundary: EffectBoundary,
  effectCause: Cause.Cause<unknown>
): EffectBoundaryFailed {
  return new EffectBoundaryFailed({
    boundary,
    cause: Cause.squash(effectCause),
    effectCause,
    pretty: Cause.pretty(effectCause),
  });
}

export function normalizeEffectBoundaryCause(
  boundary: EffectBoundary,
  effectCause: Cause.Cause<unknown>
): unknown {
  return effectCauseHasOnlyExpectedFailures(effectCause)
    ? Cause.squash(effectCause)
    : effectBoundaryFailed(boundary, effectCause);
}

export function effectCauseHasOnlyExpectedFailures(effectCause: Cause.Cause<unknown>): boolean {
  return (
    Cause.hasFails(effectCause) && !Cause.hasDies(effectCause) && !Cause.hasInterrupts(effectCause)
  );
}
