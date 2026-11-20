import { Effect } from "effect";

export interface GraphCellStateReader<TState> {
  readonly get: Effect.Effect<TState>;
  readonly getSync: () => TState;
  // Monotonic per-cell revision. Bumps on every committed write (replace /
  // transition), giving an Object.is-free identity for external stores that
  // integrate a node through `useSyncExternalStore` outside the React hooks.
  // A recreated cell is seeded past its evicted predecessor's revision so the
  // sequence never ABAs across incarnations of the same node id.
  readonly getRevisionSync: () => number;
}

export interface GraphCellState<TState> extends GraphCellStateReader<TState> {
  readonly updateSync: <A>(mutate: (state: TState) => A) => A;
  readonly transitionSync: <A>(map: (state: TState) => readonly [A, TState]) => A;
  readonly replace: (next: TState) => Effect.Effect<void>;
  readonly transition: <A>(map: (state: TState) => readonly [A, TState]) => Effect.Effect<A>;
}

// Writes are owned by serialized cell-queue operations; getSync is for passive projection only.
export function makeGraphCellState<TState>(
  initial: TState,
  initialRevision = 0
): GraphCellState<TState> {
  let current = initial;
  let revision = initialRevision;
  const replaceSync = (next: TState): void => {
    current = next;
    revision += 1;
  };
  const transitionSync = <A>(map: (state: TState) => readonly [A, TState]): A => {
    const [value, next] = map(current);
    replaceSync(next);
    return value;
  };

  return {
    updateSync: (mutate) => {
      const value = mutate(current);
      revision += 1;
      return value;
    },
    transitionSync,
    get: Effect.sync(() => current),
    replace: (next) => Effect.sync(() => replaceSync(next)),
    transition: (map) => Effect.sync(() => transitionSync(map)),
    getSync: () => current,
    getRevisionSync: () => revision,
  };
}
