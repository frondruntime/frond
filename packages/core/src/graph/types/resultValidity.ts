import type { Duration } from "effect";

export type ResultValidity =
  | {
      readonly _tag: "Current";
      readonly currentAt?: number | undefined;
    }
  | {
      readonly _tag: "Stale";
      readonly staleAt: number;
    }
  | {
      readonly _tag: "Expired";
      readonly expiredAt: number;
    };

export type ResultValidityPolicy =
  | {
      readonly _tag: "Static";
    }
  | {
      readonly _tag: "Manual";
    }
  | {
      readonly _tag: "TimeBound";
      readonly staleAfter?: Duration.Input | undefined;
      readonly expireAfter?: Duration.Input | undefined;
    };

export type NormalizedResultValidityPolicy =
  | {
      readonly _tag: "Static";
    }
  | {
      readonly _tag: "Manual";
    }
  | {
      readonly _tag: "TimeBound";
      readonly staleAfterMillis?: number | undefined;
      readonly expireAfterMillis?: number | undefined;
    };

export type ResultValidityChangedReason = "acquire" | "refresh" | "manual" | "time-bound";

export const ResultCommitTag = Symbol("frond.resultCommit");

export interface ResultCommit<TResult> {
  readonly [ResultCommitTag]: true;
  readonly result: TResult;
  readonly validity?: ResultValidity | undefined;
  readonly loadedAt?: number | undefined;
}

export interface ResultCommitOptions {
  readonly validity?: ResultValidity | undefined;
  readonly loadedAt?: number | undefined;
}

export function resultCommit<TResult>(
  result: TResult,
  options: ResultCommitOptions = {}
): ResultCommit<TResult> {
  return {
    [ResultCommitTag]: true,
    result,
    validity: options.validity,
    loadedAt: options.loadedAt,
  };
}
