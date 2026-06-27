import { Data, Effect } from "effect";
import type { RuntimeSignalAccess } from "../signals";
import type { AsyncRuntimeSignalAccess, AsyncRuntimeSignalSubscriber } from "./types";

class AsyncSignalSubscriberFailed extends Data.TaggedError("AsyncSignalSubscriberFailed")<{
  readonly subscriber: string;
  readonly cause: unknown;
}> {}

export function bridgeAsyncDriverSignals(signals: RuntimeSignalAccess): AsyncRuntimeSignalAccess {
  return {
    publish: (signal) => Effect.runPromise(signals.publish(signal)),
    readRetained: (query) => Effect.runPromise(signals.readRetained(query)),
    subscribe: (subscriber) =>
      Effect.runPromise(
        signals.subscribe({
          name: subscriber.name,
          channels: subscriber.channels,
          handle: (record) => runAsyncSignalSubscriber(subscriber, record),
        })
      ),
  };
}

function runAsyncSignalSubscriber(
  subscriber: AsyncRuntimeSignalSubscriber,
  record: Parameters<AsyncRuntimeSignalSubscriber["handle"]>[0]
): Effect.Effect<void, AsyncSignalSubscriberFailed> {
  return Effect.tryPromise({
    try: async () => subscriber.handle(record),
    catch: (cause) => new AsyncSignalSubscriberFailed({ subscriber: subscriber.name, cause }),
  });
}
