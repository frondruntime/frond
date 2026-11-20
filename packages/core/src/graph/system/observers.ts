import { Effect } from "effect";

export function notifyProjectedObservers<A, Observer>(
  observers: ReadonlyArray<Observer>,
  value: A,
  notify: (value: A, observer: Observer) => void | Effect.Effect<void>,
  onFailure?:
    | ((value: A, observer: Observer, cause: unknown) => void | Effect.Effect<void>)
    | undefined,
  start = 0
): Effect.Effect<void> {
  for (let index = start; index < observers.length; index += 1) {
    const observer = observers[index];
    if (observer === undefined) continue;
    let result: void | Effect.Effect<void>;
    try {
      result = notify(value, observer);
    } catch (cause) {
      result = reportObserverFailure(value, observer, cause, onFailure);
    }
    // Plain host observers finish inline. Only Effect observers and sinks need
    // a continuation; keep the snapshot and resume in registration order.
    if (result !== undefined && result !== Effect.void) {
      return result.pipe(
        Effect.catchCause((cause) => reportObserverFailure(value, observer, cause, onFailure)),
        Effect.flatMap(() =>
          notifyProjectedObservers(observers, value, notify, onFailure, index + 1)
        )
      );
    }
  }
  return Effect.void;
}

function reportObserverFailure<A, Observer>(
  value: A,
  observer: Observer,
  cause: unknown,
  onFailure:
    | ((value: A, observer: Observer, cause: unknown) => void | Effect.Effect<void>)
    | undefined
): Effect.Effect<void> {
  if (onFailure === undefined) {
    return Effect.void;
  }

  try {
    const result = onFailure(value, observer, cause);
    return result === undefined || result === Effect.void
      ? Effect.void
      : result.pipe(Effect.catchCause(() => Effect.void));
  } catch {
    return Effect.void;
  }
}
