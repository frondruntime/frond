import { Deferred, Effect, Exit } from "effect";
import type { GraphCellTask } from "../cell/cellActor";

export function registerAdmittedTask<TKey, TValue>(input: {
  readonly active: Map<TKey, GraphCellTask<TValue>>;
  readonly key: TKey;
  readonly start: (onComplete: () => void) => Effect.Effect<GraphCellTask<TValue>>;
}): Effect.Effect<GraphCellTask<TValue>> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const taskRegistration = yield* Deferred.make<GraphCellTask<TValue>>();
      let completed = false;
      let registeredTask: GraphCellTask<TValue> | undefined;
      const admittedTask = {
        await: Deferred.await(taskRegistration).pipe(Effect.flatMap((task) => task.await)),
      } satisfies GraphCellTask<TValue>;
      const clear = () => {
        completed = true;
        const current = input.active.get(input.key);

        if (current === admittedTask || current === registeredTask) {
          input.active.delete(input.key);
        }
      };

      input.active.set(input.key, admittedTask);

      return yield* Effect.gen(function* () {
        const task = yield* input.start(clear);
        registeredTask = task;

        if (!completed) {
          input.active.set(input.key, task);
        }

        yield* Deferred.succeed(taskRegistration, task).pipe(Effect.asVoid);
        return task;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => {
                if (input.active.get(input.key) === admittedTask) {
                  input.active.delete(input.key);
                }
              }).pipe(
                Effect.flatMap(() => Deferred.interrupt(taskRegistration)),
                Effect.asVoid
              )
        )
      );
    })
  );
}
