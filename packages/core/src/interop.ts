import { Effect } from "effect";

/**
 * Runs an Effect to a Promise — the Effect→Promise crossing.
 *
 * Use it to call an effect-mode node's action from Promise/React code:
 * `unwrapEffect(session.actions.refreshToken({ force: true }))`. A typed failure
 * surfaces as the rejection. The Effect must be self-contained (no remaining
 * requirements), which every node action already is.
 */
export function unwrapEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/**
 * Lifts a Promise-returning thunk into an Effect — the Promise→Effect crossing.
 *
 * Use it to call an async-mode node's action from an Effect pipeline, or to bring
 * any outside Promise into Effect composition:
 * `yield* wrapPromise(() => profile.actions.rename({ name }))`. The rejection
 * value becomes the Effect's failure.
 */
export function wrapPromise<A>(thunk: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: thunk, catch: (error) => error });
}
