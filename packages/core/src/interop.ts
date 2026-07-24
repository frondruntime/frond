import { Cause, Effect, Exit } from "effect";

/**
 * Runs an Effect to a Promise — the Effect→Promise crossing.
 *
 * Use it to call an effect-mode node's action from Promise/React code:
 * `unwrapEffect(session.actions.refreshToken({ force: true }))`. A typed failure
 * rejects as the original error value, so `catch` sees the error the Effect
 * failed with and `wrapPromise(() => unwrapEffect(effect))` round-trips it into
 * the error channel intact. Defects and interruption reject with the failure
 * `Cause` so they stay distinguishable from typed failures. The Effect must be
 * self-contained (no remaining requirements), which every node action already is.
 */
export function unwrapEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const reasons = exit.cause.reasons;
    const fail = reasons.every(Cause.isFailReason) ? reasons[0] : undefined;

    // Plain typed failure: surface the original error value as the rejection.
    if (fail !== undefined) {
      throw fail.error;
    }

    // Defect or interruption: reject with the cause itself so untyped crashes
    // never masquerade as a typed failure.
    throw exit.cause;
  });
}

/**
 * Lifts a Promise-returning thunk into an Effect — the Promise→Effect crossing.
 *
 * Use it to call an async-mode node's action from an Effect pipeline, or to bring
 * any outside Promise into Effect composition:
 * `yield* wrapPromise(() => profile.actions.rename({ name }))`. The rejection
 * value becomes the Effect's failure. The thunk receives an `AbortSignal` that
 * fires when the wrapping Effect is interrupted, so cancellation-aware Promises
 * can abort instead of running detached; a zero-arg thunk simply ignores it.
 */
export function wrapPromise<A>(
  thunk: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: thunk, catch: (error) => error });
}
