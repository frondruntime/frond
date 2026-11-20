import type { GraphCellTask } from "../queue/reply";

/** Submission only posts a job, so registration always precedes execution. */
export function registerAdmittedTask<TKey, TValue>(input: {
  readonly active: Map<TKey, GraphCellTask<TValue>>;
  readonly key: TKey;
  readonly start: (onComplete: () => void) => GraphCellTask<TValue>;
}): GraphCellTask<TValue> {
  const task = input.start(() => {
    if (input.active.get(input.key) === task) input.active.delete(input.key);
  });
  input.active.set(input.key, task);
  return task;
}
