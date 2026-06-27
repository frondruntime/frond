import { Effect } from "effect";

export interface GraphCellStateReader<TState> {
  readonly get: Effect.Effect<TState>;
  readonly getSync: () => TState;
}

export interface GraphCellState<TState> extends GraphCellStateReader<TState> {
  readonly replace: (next: TState) => Effect.Effect<void>;
  readonly transition: <A>(map: (state: TState) => readonly [A, TState]) => Effect.Effect<A>;
}

// Writes are owned by serialized cell-actor operations; getSync is for passive projection only.
export function makeGraphCellState<TState>(initial: TState): GraphCellState<TState> {
  let current = initial;

  return {
    get: Effect.sync(() => current),
    replace: (next) =>
      Effect.sync(() => {
        current = next;
      }),
    transition: (map) =>
      Effect.sync(() => {
        const [value, next] = map(current);
        current = next;
        return value;
      }),
    getSync: () => current,
  };
}
