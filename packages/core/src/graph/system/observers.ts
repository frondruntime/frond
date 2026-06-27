import { Effect } from "effect";

export function notifyObservers<A>(
  observers: Iterable<(value: A) => Effect.Effect<void>>,
  value: A
): Effect.Effect<void> {
  return notifyProjectedObservers(observers, value, (observedValue, observer) =>
    observer(observedValue)
  );
}

export function notifyProjectedObservers<A, Observer>(
  observers: Iterable<Observer>,
  value: A,
  notify: (value: A, observer: Observer) => Effect.Effect<void>,
  onFailure?: ((value: A, observer: Observer, cause: unknown) => Effect.Effect<void>) | undefined
): Effect.Effect<void> {
  return Effect.forEach(
    [...observers],
    (observer) =>
      Effect.suspend(() => {
        try {
          return notify(value, observer).pipe(
            Effect.catchCause((cause) => reportObserverFailure(value, observer, cause, onFailure))
          );
        } catch (cause) {
          return reportObserverFailure(value, observer, cause, onFailure);
        }
      }),
    { concurrency: 1, discard: true }
  );
}

function reportObserverFailure<A, Observer>(
  value: A,
  observer: Observer,
  cause: unknown,
  onFailure: ((value: A, observer: Observer, cause: unknown) => Effect.Effect<void>) | undefined
): Effect.Effect<void> {
  if (onFailure === undefined) {
    return Effect.void;
  }

  return Effect.suspend(() => onFailure(value, observer, cause)).pipe(
    Effect.catchCause(() => Effect.void)
  );
}
