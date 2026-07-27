import { Deferred, Effect, Exit, Fiber, Ref, Scope, Semaphore } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";

export interface GraphCellActor {
  readonly submit: <A>(
    operation: GraphCellOperation<A>,
    options?: GraphCellSubmitOptions | undefined
  ) => Effect.Effect<GraphCellTask<A>>;
  readonly run: <A>(operation: GraphCellOperation<A>) => Effect.Effect<A>;
  readonly close: (reason?: RuntimeCancellationReason | undefined) => Effect.Effect<void>;
  readonly runExclusive: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>;
  readonly runExclusiveFork: <A>(effect: Effect.Effect<A>) => Effect.Effect<Fiber.Fiber<A>>;
  readonly shutdown: <A>(options?: {
    readonly reason?: RuntimeCancellationReason | undefined;
    readonly cleanup?: Effect.Effect<A> | undefined;
  }) => Effect.Effect<A | undefined>;
}

export interface GraphCellTask<A> {
  readonly await: Effect.Effect<A>;
}

export interface GraphCellOperation<A> {
  readonly effect: Effect.Effect<A>;
  readonly interrupt: (
    reply: Deferred.Deferred<A>,
    reason?: RuntimeCancellationReason | undefined
  ) => Effect.Effect<void>;
}

export interface GraphCellSubmitOptions {
  /**
   * Runs synchronously when this submission claims its reply, before awaiters are resumed.
   * It is intentionally not an Effect: admission cleanup must not park the cell permit.
   */
  readonly onComplete?: (() => void) | undefined;
  /**
   * Propagates awaiter interruption to the submission: interrupting the fiber
   * that awaits the task claims the reply and interrupts the worker, so the
   * operation's own interruption handling runs (e.g. an action's onInterrupt
   * aborts its AbortSignal). Only single-owner operations may set this; a task
   * shared by multiple awaiters (joined actions, deduped readiness, refreshes)
   * must NOT be interruptible, or one awaiter leaving would abort work the
   * others still need.
   */
  readonly interruptible?: boolean | undefined;
}

interface AcceptedGraphCellSubmission {
  readonly settled: Ref.Ref<boolean>;
  fiber: Fiber.Fiber<void> | undefined;
  readonly interruptOnce: (
    reason?: RuntimeCancellationReason | undefined,
    interruptFiber?: boolean | undefined
  ) => Effect.Effect<void>;
}

export function makeGraphCellActor(): Effect.Effect<GraphCellActor> {
  return Effect.gen(function* () {
    const semaphore = Semaphore.makeUnsafe(1);
    const scope = yield* Scope.make("sequential");
    const closed = yield* Ref.make(false);
    const submissions = new Set<AcceptedGraphCellSubmission>();

    const submit = <A>(
      operation: GraphCellOperation<A>,
      options?: GraphCellSubmitOptions | undefined
    ): Effect.Effect<GraphCellTask<A>> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const reply = yield* Deferred.make<A>();
          const settled = yield* Ref.make(false);
          const onComplete = Effect.sync(() => {
            options?.onComplete?.();
          }).pipe(Effect.catchCause(() => Effect.void));

          const submission: AcceptedGraphCellSubmission = {
            settled,
            fiber: undefined,
            interruptOnce: (reason, interruptFiber = true) =>
              claimReply(settled).pipe(
                Effect.flatMap((alreadySettled) =>
                  alreadySettled
                    ? Effect.void
                    : operation.interrupt(reply, reason).pipe(
                        Effect.flatMap(() => onComplete),
                        Effect.flatMap(() =>
                          interruptFiber && submission.fiber !== undefined
                            ? Fiber.interrupt(submission.fiber)
                            : Effect.void
                        ),
                        Effect.asVoid
                      )
                )
              ),
          };
          submissions.add(submission);

          // Contract: each graph cell serializes driver work, lifecycle mutation,
          // and interruption handling. Callers may enqueue, but only one operation
          // may own the ready state at a time.
          const workerEffect = Semaphore.withPermit(
            semaphore,
            Effect.gen(function* () {
              // Hazard: close can interrupt an accepted submission while this
              // worker waits for the permit. `settled`/`interruptOnce` are the
              // single reply latch; after the permit is held there is no
              // suspension point between this closed check and operation start.
              if (yield* Ref.get(closed)) {
                yield* submission.interruptOnce(
                  {
                    _tag: "Released",
                    detail: "graph cell is closed",
                  },
                  false
                );
                return;
              }

              yield* completeReply(reply, operation.effect, settled, onComplete);
            })
          ).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const wasSettled = yield* Ref.get(settled);

                if (!wasSettled) {
                  yield* submission.interruptOnce(
                    {
                      _tag: "Released",
                      detail: "graph cell operation exited before settling reply",
                    },
                    false
                  );
                }

                submissions.delete(submission);
              })
            )
          );

          submission.fiber = yield* workerEffect.pipe(
            Effect.forkIn(scope, { startImmediately: true })
          );

          // For a single-owner operation, propagate awaiter interruption to the
          // submission: claiming the reply runs the operation's own interruption
          // handling (an action aborts its AbortSignal) and interrupts the
          // worker. Shared tasks (joined actions, deduped readiness, refreshes)
          // omit the flag and keep running for their other awaiters.
          const awaitReply =
            options?.interruptible === true
              ? Deferred.await(reply).pipe(
                  Effect.onInterrupt(() =>
                    submission.interruptOnce({
                      _tag: "Interrupted",
                      detail: "operation awaiter interrupted",
                    })
                  )
                )
              : Deferred.await(reply);

          return { await: awaitReply };
        })
      );

    const close = (reason?: RuntimeCancellationReason | undefined): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.set(closed, true);
        const accepted = [...submissions];
        yield* Effect.forEach(accepted, (submission) => submission.interruptOnce(reason), {
          concurrency: "unbounded",
          discard: true,
        });
      });

    const runExclusive = <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
      Semaphore.withPermit(semaphore, effect);

    const runExclusiveFork = <A>(effect: Effect.Effect<A>): Effect.Effect<Fiber.Fiber<A>> =>
      runExclusive(effect).pipe(Effect.forkIn(scope, { startImmediately: true }));

    return {
      submit,
      run: (operation) => submit(operation).pipe(Effect.flatMap((task) => task.await)),
      close,
      runExclusive,
      runExclusiveFork,
      shutdown: (options) =>
        Effect.gen(function* () {
          yield* close(options?.reason);
          const cleanup = options?.cleanup;
          const result = cleanup === undefined ? undefined : yield* runExclusive(cleanup);
          yield* Scope.close(scope, Exit.succeed(undefined));
          return result;
        }),
    };
  });
}

// Live-lease and unsafe-update ops interrupt through `Deferred.interrupt`, which
// produces an `Interrupted` cause that downstream interrupt handlers do not
// consult. The richer `RuntimeCancellationReason` carried by action / refresh /
// args paths intentionally has no consumer here, so the parameter is accepted
// to match the actor-bridge signature but deliberately not propagated.
export function interruptCellOperation<A>(
  reply: Deferred.Deferred<A>,
  reason?: RuntimeCancellationReason | undefined
): Effect.Effect<void> {
  void reason;
  return Deferred.interrupt(reply).pipe(Effect.asVoid);
}

function completeReply<A>(
  reply: Deferred.Deferred<A>,
  effect: Effect.Effect<A>,
  settled: Ref.Ref<boolean>,
  onComplete: Effect.Effect<void>
): Effect.Effect<void> {
  return effect.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => settleReply(settled, onComplete, Deferred.failCause(reply, cause)),
      onSuccess: (value) => settleReply(settled, onComplete, Deferred.succeed(reply, value)),
    }),
    Effect.asVoid
  );
}

function settleReply<A>(
  settled: Ref.Ref<boolean>,
  onComplete: Effect.Effect<void>,
  settle: Effect.Effect<A>
): Effect.Effect<void> {
  return claimReply(settled).pipe(
    Effect.flatMap((alreadySettled) =>
      alreadySettled
        ? Effect.void
        : settle.pipe(
            Effect.flatMap(() => onComplete),
            Effect.asVoid
          )
    )
  );
}

function claimReply(settled: Ref.Ref<boolean>): Effect.Effect<boolean> {
  return Ref.modify(settled, (alreadySettled) => [alreadySettled, true] as const);
}
