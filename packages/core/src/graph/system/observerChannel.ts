import { Effect } from "effect";
import type { GraphObserverChannel, GraphSubscription } from "../types";
import { notifyProjectedObservers } from "./observers";

export interface ObserverFailure {
  readonly channel: GraphObserverChannel;
  readonly value: unknown;
  readonly cause: unknown;
}

export interface ObserverChannelOptions<TArgs extends ReadonlyArray<unknown>> {
  readonly channel: GraphObserverChannel;
  readonly reportFailure?:
    | ((failure: ObserverFailure & { readonly value: TArgs }) => Effect.Effect<void>)
    | undefined;
}

export interface ObserverChannel<TObserver, TArgs extends ReadonlyArray<unknown>> {
  readonly subscribe: (observer: TObserver) => Effect.Effect<GraphSubscription>;
  readonly notifyAll: (...args: TArgs) => Effect.Effect<void>;
}

export function makeObserverChannel<
  TObserver extends (...args: TArgs) => Effect.Effect<void>,
  TArgs extends ReadonlyArray<unknown>,
>(options?: ObserverChannelOptions<TArgs> | undefined): ObserverChannel<TObserver, TArgs> {
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
    notifyAll: (...args) =>
      notifyProjectedObservers(
        observers,
        args,
        (observedArgs, observer) => observer(...observedArgs),
        (failedArgs, _observer, cause) =>
          options?.reportFailure === undefined
            ? Effect.void
            : options.reportFailure({
                channel: options.channel,
                value: failedArgs,
                cause,
              })
      ),
  };
}
