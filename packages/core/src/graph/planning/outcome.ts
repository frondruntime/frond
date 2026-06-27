export type GraphOutcome<TValue, TFailure> =
  | {
      readonly _tag: "Success";
      readonly value: TValue;
    }
  | {
      readonly _tag: "Failure";
      readonly failure: TFailure;
    };

export function graphSuccess<TValue>(value: TValue): GraphOutcome<TValue, never> {
  return { _tag: "Success", value };
}

export function graphFailure<TFailure>(failure: TFailure): GraphOutcome<never, TFailure> {
  return { _tag: "Failure", failure };
}
