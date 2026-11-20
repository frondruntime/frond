import { Clock, Context, Effect, Exit, Fiber, Option, References, Tracer } from "effect";
import { timedOutCancellation } from "../../cancellation";
import type { DriverRunResult } from "../../driver/types";
import type { GraphNodeCell } from "../cell/cellModel";
import { interruptedCancellation } from "../lifecycle/operationDisposers";
import type { GraphJob } from "../queue/jobQueue";
import {
  DriverOperationTimedOut,
  type DriverOperationTimeoutMs,
  DriverPromiseFailed,
} from "../types";
import { type EffectBoundary, normalizeEffectBoundaryCause } from "./effectBoundary";

export interface DriverEdgeInput<A> {
  readonly cell: GraphNodeCell;
  readonly operation: string;
  readonly boundary: EffectBoundary;
  readonly timeout: DriverOperationTimeoutMs | "unbounded";
  readonly abortController: AbortController;
  readonly spanName: string;
  readonly spanAttributes: Record<string, unknown>;
  readonly run: () => DriverRunResult<A>;
  readonly onProduced?: ((value: A) => void) | undefined;
  readonly onAbandonedResource?: ((value: A) => void) | undefined;
  /** Runs when the edge ends with an exit, before its settle job is posted. */
  readonly onDecided?: (() => void) | undefined;
}

const noInterrupt = () => Effect.void;

/** The only hook execution boundary. Every exit re-enters through a settle job. */
export function startEdge<A>(
  input: DriverEdgeInput<A>,
  context: Context.Context<never> | undefined,
  settle: (exit: Exit.Exit<A, unknown>) => void
): () => Effect.Effect<void> {
  let ended = false;
  let timer: Fiber.Fiber<void> | undefined;
  let worker: Fiber.Fiber<A, unknown> | undefined;
  // An Effect-mode body is traced by its own `withSpan`; any other body is
  // traced only for a caller that brought a span (the Effect facade).
  const span =
    input.cell.descriptor.driver.mode === "effect" ? undefined : openEdgeSpan(input, context);
  const post = (exit: Exit.Exit<A, unknown>) => {
    if (ended) {
      if (exit._tag === "Success") input.onAbandonedResource?.(exit.value);
      return;
    }
    ended = true;
    timer?.interruptUnsafe();
    if (span !== undefined) endEdgeSpan(span, context, exit);
    if (exit._tag === "Success") input.onProduced?.(exit.value);
    input.onDecided?.();
    input.cell.jobs.post(new DriverSettleJob(settle, exit));
  };
  const failed = (cause: unknown) =>
    post(
      Exit.fail(
        new DriverPromiseFailed({
          nodeId: input.cell.nodeId,
          tag: input.cell.tag,
          operation: input.operation,
          cause,
        })
      )
    );
  let result: DriverRunResult<A>;
  try {
    result = input.run();
  } catch (cause) {
    failed(cause);
    return noInterrupt;
  }

  const timeoutFailure = () => {
    const timeout = input.timeout;
    if (timeout === "unbounded") throw new Error("Unbounded driver edge has no deadline");
    const failure = new DriverOperationTimedOut({
      nodeId: input.cell.nodeId,
      tag: input.cell.tag,
      operation: input.operation,
      timeout,
      cancellation: timedOutCancellation(timeout),
    });
    input.abortController.abort(failure);
    return failure;
  };
  if (input.cell.descriptor.driver.mode === "effect") {
    // Effect normalization guarantees an Effect even for an omitted void hook.
    const body =
      result === undefined
        ? (Effect.void as Effect.Effect<A>)
        : (result as Effect.Effect<A, unknown>);
    const timed =
      input.timeout === "unbounded"
        ? body
        : body.pipe(
            Effect.timeoutOrElse({
              duration: input.timeout,
              orElse: () => Effect.fail(timeoutFailure()),
            })
          );
    const effect = Effect.withSpan(timed, input.spanName, {
      attributes: input.spanAttributes,
      captureStackTrace: false,
    });
    worker = context === undefined ? Effect.runFork(effect) : Effect.runForkWith(context)(effect);
    worker.addObserver((exit) =>
      post(
        exit._tag === "Success"
          ? exit
          : Exit.fail(normalizeEffectBoundaryCause(input.boundary, exit.cause))
      )
    );
  } else {
    try {
      if (!isPromiseLike<A>(result)) {
        post(Exit.succeed(result as A));
        return noInterrupt;
      }
      // Keep timeouts on Effect, but never wrap a promise hook in an Effect.
      if (input.timeout !== "unbounded") {
        const deadline = Effect.sleep(input.timeout).pipe(
          Effect.andThen(
            Effect.sync(() => {
              timer = undefined;
              post(Exit.fail(timeoutFailure()));
            })
          )
        );
        timer =
          context === undefined ? Effect.runFork(deadline) : Effect.runForkWith(context)(deadline);
      }
      // A thenable may call back more than once. Only its first settlement
      // counts: a repeat must neither settle again nor reach abandoned-resource
      // cleanup, which takes only the first value produced after the edge ended.
      let thenSettled = false;
      result.then(
        (value) => {
          if (thenSettled) return;
          thenSettled = true;
          post(Exit.succeed(value));
        },
        (cause) => {
          if (thenSettled) return;
          thenSettled = true;
          failed(cause);
        }
      );
    } catch (cause) {
      failed(cause);
    }
  }
  return () => {
    if (span !== undefined && !ended) endEdgeSpan(span, context, Exit.interrupt());
    ended = true;
    input.abortController.abort(interruptedCancellation());
    timer?.interruptUnsafe();
    return worker === undefined ? Effect.void : Fiber.interrupt(worker);
  };
}

function openEdgeSpan<A>(
  input: DriverEdgeInput<A>,
  context: Context.Context<never> | undefined
): Tracer.Span | undefined {
  if (context === undefined || Option.isNone(Context.getOption(context, Tracer.ParentSpan)))
    return undefined;
  return Effect.runSyncWith(context)(
    Effect.makeSpan(input.spanName, { attributes: input.spanAttributes })
  );
}

function endEdgeSpan(
  span: Tracer.Span,
  context: Context.Context<never> | undefined,
  exit: Exit.Exit<unknown, unknown>
): void {
  if (context === undefined || span.status._tag === "Ended") return;
  span.end(
    Context.getUnsafe(context, References.TracerTimingEnabled)
      ? Context.getUnsafe(context, Clock.Clock).currentTimeNanosUnsafe()
      : 0n,
    exit
  );
}

function isPromiseLike<A>(value: unknown): value is PromiseLike<A> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Effect consumers share the same edge, with their caller's services and tracer. */
export function runTimedDriverOperation<A>(input: DriverEdgeInput<A>): Effect.Effect<A, unknown> {
  return Effect.withFiber((fiber) =>
    Effect.callback((resume) => {
      const cancel = startEdge(input, fiber.context, (exit) => resume(exit));
      return Effect.suspend(cancel);
    })
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

class DriverSettleJob<A> implements GraphJob {
  constructor(
    private readonly settle: (exit: Exit.Exit<A, unknown>) => void,
    private readonly exit: Exit.Exit<A, unknown>
  ) {}
  run(): void {
    this.settle(this.exit);
  }
}
