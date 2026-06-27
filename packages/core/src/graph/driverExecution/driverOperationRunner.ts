import { Cause, Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import { AsyncDriverHookFailed } from "../../driver/asyncDefinition";
import type { GraphNodeCell } from "../planning/plan";
import {
  DriverOperationTimedOut,
  type DriverOperationTimeoutMs,
  DriverPromiseFailed,
  type ResultCommit,
} from "../types";
import type { EffectBoundary } from "./effectBoundary";
import { normalizeEffectBoundaryCause } from "./effectBoundary";

export function runDriverOperation<TValue>(input: {
  readonly cell: GraphNodeCell;
  readonly operation: string;
  readonly boundary: EffectBoundary;
  readonly spanName: string;
  readonly spanAttributes: Record<string, unknown>;
  readonly run: () => Effect.Effect<TValue | ResultCommit<TValue>, unknown> | undefined;
}): Effect.Effect<TValue | ResultCommit<TValue>, unknown> {
  return runRawDriverOperation(input.cell, input.operation, input.run).pipe(
    Effect.withSpan(input.spanName, { attributes: input.spanAttributes }),
    Effect.catchCause((cause) => Effect.fail(normalizeEffectBoundaryCause(input.boundary, cause)))
  );
}

export function runTimedDriverOperation<TValue>(input: {
  readonly cell: GraphNodeCell;
  readonly operation: string;
  readonly boundary: EffectBoundary;
  readonly timeout: DriverOperationTimeoutMs;
  readonly abortController: AbortController;
  readonly spanName: string;
  readonly spanAttributes: Record<string, unknown>;
  readonly run: () => Effect.Effect<TValue | ResultCommit<TValue>, unknown> | undefined;
}): Effect.Effect<TValue | ResultCommit<TValue>, unknown> {
  return runRawDriverOperation(input.cell, input.operation, input.run).pipe(
    Effect.timeout(input.timeout),
    Effect.catch((cause) => {
      if (Cause.isTimeoutError(cause)) {
        input.abortController.abort(cause);
        return Effect.fail(
          new DriverOperationTimedOut({
            nodeId: input.cell.nodeId,
            tag: input.cell.tag,
            operation: input.operation,
            timeout: input.timeout,
            cancellation: timeoutCancellation(input.timeout),
          })
        );
      }

      return Effect.fail(cause);
    }),
    Effect.withSpan(input.spanName, { attributes: input.spanAttributes }),
    Effect.catchCause((cause) => Effect.fail(normalizeEffectBoundaryCause(input.boundary, cause)))
  );
}

export function withDriverOperationBoundary<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  boundary: EffectBoundary
): Effect.Effect<A, E | unknown, R> {
  return effect.pipe(
    Effect.catchCause((cause) => Effect.fail(normalizeEffectBoundaryCause(boundary, cause)))
  );
}

export function recoverDriverOperationFailure<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  boundary: EffectBoundary,
  recover: (cause: unknown) => Effect.Effect<A, never, R>
): Effect.Effect<A, never, R> {
  return withDriverOperationBoundary(effect, boundary).pipe(Effect.catch(recover));
}

function runRawDriverOperation<TValue>(
  cell: GraphNodeCell,
  operation: string,
  run: () => Effect.Effect<TValue | ResultCommit<TValue>, unknown> | undefined
): Effect.Effect<TValue | ResultCommit<TValue>, unknown> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      new DriverPromiseFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        operation,
        cause,
      }),
  }).pipe(
    Effect.flatMap((result) => {
      const effect =
        result === undefined
          ? (Effect.void as Effect.Effect<TValue | ResultCommit<TValue>, never>)
          : result;

      if (cell.descriptor.driver.mode === "effect") {
        return effect;
      }

      return effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof DriverPromiseFailed
            ? cause
            : new DriverPromiseFailed({
                nodeId: cell.nodeId,
                tag: cell.tag,
                operation,
                cause: cause instanceof AsyncDriverHookFailed ? cause.cause : cause,
              })
        )
      );
    })
  );
}

function timeoutCancellation(timeout: number): RuntimeCancellationReason {
  return {
    _tag: "TimedOut",
    detail: `${timeout}ms`,
  };
}
