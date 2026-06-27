import { FrondRuntimeInvariantViolation } from "./errors";

export function optionalNonNegativeInteger(input: {
  readonly value: number | undefined;
  readonly label: string;
  readonly cause: unknown;
}): number | undefined {
  const value = input.value;

  if (value === undefined) {
    return undefined;
  }

  return providedNonNegativeInteger({ value, label: input.label, cause: input.cause });
}

export function nonNegativeIntegerWithDefault(input: {
  readonly value: number | undefined;
  readonly defaultValue: number;
  readonly label: string;
  readonly cause: unknown;
}): number {
  const value = input.value;

  if (value === undefined) {
    return input.defaultValue;
  }

  return providedNonNegativeInteger({ value, label: input.label, cause: input.cause });
}

function providedNonNegativeInteger(input: {
  readonly value: number;
  readonly label: string;
  readonly cause: unknown;
}): number {
  if (Number.isFinite(input.value) && Number.isInteger(input.value) && input.value >= 0) {
    return input.value;
  }

  throw new FrondRuntimeInvariantViolation({
    message: `${input.label} must be a non-negative finite integer; received ${String(input.value)}.`,
    cause: input.cause,
  });
}
