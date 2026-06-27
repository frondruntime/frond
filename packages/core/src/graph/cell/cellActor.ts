import { Deferred, Effect, Exit, Fiber, Ref, Scope, Semaphore } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";

export interface GraphCellActor {
  readonly submit: <A>(operation: GraphCellOperation<A>) => Effect.Effect<GraphCellTask<A>>;
  readonly run: <A>(operation: GraphCellOperation<A>) => Effect.Effect<A>;
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

interface ActiveGraphCellOperation {
  readonly fiber: Fiber.Fiber<void>;
  readonly interrupt: (reason?: RuntimeCancellationReason | undefined) => Effect.Effect<void>;
}

export function makeGraphCellActor(): Effect.Effect<GraphCellActor> {
  return Effect.gen(function* () {
    const semaphore = Semaphore.makeUnsafe(1);
    const scope = yield* Scope.make("sequential");
    const activeOperation = yield* Ref.make<ActiveGraphCellOperation | undefined>(undefined);
    const closed = yield* Ref.make(false);

    const submit = <A>(operation: GraphCellOperation<A>): Effect.Effect<GraphCellTask<A>> =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<A>();
        // Contract: each graph cell serializes driver work, lifecycle mutation,
        // and interruption handling. Callers may enqueue, but only one operation
        // may own the ready state at a time.
        const waitEffect = Semaphore.withPermit(
          semaphore,
          Effect.gen(function* () {
            const alreadyClosed = yield* Ref.get(closed);

            if (alreadyClosed) {
              yield* operation.interrupt(reply, {
                _tag: "Released",
                detail: "graph cell is closed",
              });
              return yield* Deferred.await(reply);
            }

            const start = yield* Deferred.make<void>();
            const worker = yield* Deferred.await(start).pipe(
              Effect.flatMap(() => completeReply(reply, operation.effect)),
              Effect.ensuring(Ref.set(activeOperation, undefined)),
              Effect.forkIn(scope, { startImmediately: true })
            );
            const interrupt = (reason?: RuntimeCancellationReason | undefined) =>
              operation.interrupt(reply, reason).pipe(
                Effect.flatMap(() => Fiber.interrupt(worker)),
                Effect.asVoid
              );

            yield* Ref.set(activeOperation, { fiber: worker, interrupt });

            const closedBeforeStart = yield* Ref.get(closed);

            // Hazard: shutdown may win after the worker fiber is registered but
            // before start is released. Interrupt here to avoid a closed actor
            // starting fresh driver work.
            if (closedBeforeStart) {
              yield* interrupt({
                _tag: "Released",
                detail: "graph cell is closed",
              });
            } else {
              yield* Deferred.succeed(start, undefined).pipe(Effect.asVoid);
            }

            yield* Fiber.await(worker);
            return yield* Deferred.await(reply);
          })
        );

        return { await: waitEffect };
      });

    return {
      submit,
      run: (operation) => submit(operation).pipe(Effect.flatMap((task) => task.await)),
      shutdown: (options) =>
        Effect.gen(function* () {
          yield* Ref.set(closed, true);
          const running = yield* Ref.get(activeOperation);

          if (running !== undefined) {
            yield* running.interrupt(options?.reason);
          }

          const cleanup = options?.cleanup;
          const result =
            cleanup === undefined ? undefined : yield* Semaphore.withPermit(semaphore, cleanup);
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
  effect: Effect.Effect<A>
): Effect.Effect<void> {
  return effect.pipe(
    Effect.flatMap((value) => Deferred.succeed(reply, value)),
    Effect.catchCause((cause) => Deferred.failCause(reply, cause)),
    Effect.asVoid
  );
}
