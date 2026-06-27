import { type Effect, Exit, Scope } from "effect";

export interface RuntimeScope {
  readonly addFinalizer: (finalizer: Effect.Effect<unknown>) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export const makeRuntimeScope = (): RuntimeScope => {
  const scope = Scope.makeUnsafe("sequential");

  return {
    addFinalizer: (finalizer) => Scope.addFinalizer(scope, finalizer),
    close: () => Scope.close(scope, Exit.succeed(undefined)),
  };
};
