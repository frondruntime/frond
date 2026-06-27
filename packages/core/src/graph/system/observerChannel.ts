import { Effect } from "effect";
import type { GraphObserverChannel, GraphSubscription } from "../types";
import { notifyProjectedObservers } from "./observers";

export interface ObserverFailure {
  readonly channel: GraphObserverChannel;
  readonly value: unknown;
  readonly cause: unknown;
}

export interface ObserverChannelOptions<TValue> {
  readonly channel: GraphObserverChannel;
  readonly reportFailure?:
    | ((failure: ObserverFailure & { readonly value: TValue }) => Effect.Effect<void>)
    | undefined;
}

export interface ObserverChannel<TObserver> {
  readonly subscribe: (observer: TObserver) => Effect.Effect<GraphSubscription>;
  readonly notifyAll: <TValue>(
    value: TValue,
    notify: (value: TValue, observer: TObserver) => Effect.Effect<void>
  ) => Effect.Effect<void>;
}

export function makeObserverChannel<TObserver, TValue = unknown>(
  options?: ObserverChannelOptions<TValue> | undefined
): ObserverChannel<TObserver> {
  const observers = new Set<TObserver>();

  return {
    subscribe: (observer) =>
      Effect.sync(() => {
        observers.add(observer);
        return {
          unsubscribe: () => {
            observers.delete(observer);
          },
        };
      }),
    notifyAll: (value, notify) =>
      notifyProjectedObservers(observers, value, notify, (failedValue, _observer, cause) =>
        options?.reportFailure === undefined
          ? Effect.void
          : options.reportFailure({
              channel: options.channel,
              value: failedValue as unknown as TValue,
              cause,
            })
      ),
  };
}
