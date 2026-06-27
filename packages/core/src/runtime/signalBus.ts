import { Clock, Effect } from "effect";
import { effectBoundaryFailed } from "../graph/driverExecution/effectBoundary";
import type {
  RuntimeSignal,
  RuntimeSignalQuery,
  RuntimeSignalRecord,
  RuntimeSignalSubscriber,
  RuntimeSignalSubscription,
} from "../signals";
import type { RuntimeSignalBusService } from "../signals/busContext";
import type { RuntimeEventBus } from "./eventBus";
import { RuntimeEvents } from "./events";
import { optionalNonNegativeInteger } from "./limits";
import { signalSpanAttributes, withRuntimeSpan } from "./observability";
import type { RuntimeSignalPolicyRegistry } from "./options";
import type { RuntimeId, RuntimeWorkContext } from "./types";

export function makeRuntimeSignalBus(input: {
  readonly runtimeId: RuntimeId;
  readonly eventBus: RuntimeEventBus;
  readonly policies: RuntimeSignalPolicyRegistry;
  readonly subscribers: ReadonlyArray<RuntimeSignalSubscriber>;
}): RuntimeSignalBusService {
  const recordsByChannel = new Map<RuntimeSignal["channel"], Array<RuntimeSignalRecord>>();
  const subscribers = new Set<RuntimeSignalSubscriber>(input.subscribers);
  // Snapshot of `subscribers`, rebuilt only on (un)subscribe so each publish
  // filters a stable array instead of copying the Set every time.
  let subscriberList: ReadonlyArray<RuntimeSignalSubscriber> = [...subscribers];
  let sequence = 0;

  const store = (record: RuntimeSignalRecord): void => {
    const policy = signalPolicy(input.policies, record.signal.channel);

    if (policy.retention === "none") {
      return;
    }

    // Per-channel buffers keep publish O(bufferSize) for the trim and O(1)
    // otherwise; global ordering is reconstructed at query time from `sequence`.
    let channelRecords = recordsByChannel.get(record.signal.channel);

    if (channelRecords === undefined) {
      channelRecords = [];
      recordsByChannel.set(record.signal.channel, channelRecords);
    }

    channelRecords.push(record);
    const excess = channelRecords.length - policy.bufferSize;

    if (excess > 0) {
      channelRecords.splice(0, excess);
    }
  };

  const deliver = (
    record: RuntimeSignalRecord,
    work?: RuntimeWorkContext | undefined
  ): Effect.Effect<void> =>
    withRuntimeSpan(
      Effect.forEach(
        subscriberList.filter((subscriber) => acceptsSignal(subscriber, record.signal)),
        (subscriber) => deliverToSubscriber(subscriber, record, work),
        { concurrency: 1, discard: true }
      ).pipe(Effect.asVoid),
      "frond.runtime.signal.deliver",
      signalSpanAttributes({ runtimeId: input.runtimeId, record, work })
    );

  const deliverToSubscriber = (
    subscriber: RuntimeSignalSubscriber,
    record: RuntimeSignalRecord,
    work?: RuntimeWorkContext | undefined
  ): Effect.Effect<void> =>
    withRuntimeSpan(
      Effect.suspend(() => subscriber.handle(record)).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            yield* input.eventBus.emit(
              RuntimeEvents.runtimeSignalSubscriberFailureObserved(
                subscriber.name,
                record,
                effectBoundaryFailed("runtime-signal-subscriber", cause),
                at
              ),
              work
            );
          })
        )
      ),
      "frond.runtime.signal.subscriber",
      signalSpanAttributes({
        runtimeId: input.runtimeId,
        record,
        subscriber: subscriber.name,
        work,
      })
    );

  return {
    publish: (signal, work) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const recordedAt = yield* Clock.currentTimeMillis;
          sequence += 1;
          const record: RuntimeSignalRecord = {
            runtimeId: input.runtimeId,
            sequence,
            recordedAt,
            signal,
          };

          store(record);
          yield* input.eventBus.emit(
            RuntimeEvents.runtimeSignalPublished(record, recordedAt),
            work
          );
          yield* deliver(record, work);
        }),
        "frond.runtime.signal.publish",
        signalSpanAttributes({ runtimeId: input.runtimeId, signal, work })
      ),
    readRetained: (query) => Effect.succeed(queryRecords(recordsByChannel, query)),
    subscribe: (subscriber) =>
      Effect.sync(() => {
        subscribers.add(subscriber);
        subscriberList = [...subscribers];

        return {
          unsubscribe: () => {
            subscribers.delete(subscriber);
            subscriberList = [...subscribers];
          },
        } satisfies RuntimeSignalSubscription;
      }),
    records: (query) => Effect.succeed(queryRecords(recordsByChannel, query)),
    subscribers: () => Effect.succeed([...subscribers].map((subscriber) => subscriber.name)),
  };
}

function signalPolicy(
  policies: RuntimeSignalPolicyRegistry,
  channel: RuntimeSignal["channel"]
): RuntimeSignalPolicyRegistry["defaultPolicy"] {
  const policy = policies.byChannel[channel];

  return policy === undefined ? policies.defaultPolicy : policy;
}

function acceptsSignal(subscriber: RuntimeSignalSubscriber, signal: RuntimeSignal): boolean {
  return subscriber.channels === undefined || subscriber.channels.includes(signal.channel);
}

function queryRecords(
  recordsByChannel: ReadonlyMap<RuntimeSignal["channel"], ReadonlyArray<RuntimeSignalRecord>>,
  query: RuntimeSignalQuery | undefined
): ReadonlyArray<RuntimeSignalRecord> {
  const filtered =
    query?.channel === undefined
      ? mergeBySequence(recordsByChannel)
      : (recordsByChannel.get(query.channel) ?? []);
  const limit = signalQueryLimit(query?.limit);

  if (limit === undefined) {
    return [...filtered];
  }

  return limit === 0 ? [] : filtered.slice(-limit);
}

function mergeBySequence(
  recordsByChannel: ReadonlyMap<RuntimeSignal["channel"], ReadonlyArray<RuntimeSignalRecord>>
): ReadonlyArray<RuntimeSignalRecord> {
  const merged: Array<RuntimeSignalRecord> = [];

  for (const channelRecords of recordsByChannel.values()) {
    merged.push(...channelRecords);
  }

  // Per-channel buffers are each in insertion order; `sequence` is the monotonic
  // global publish counter, so sorting by it restores cross-channel order.
  return merged.sort((left, right) => left.sequence - right.sequence);
}

function signalQueryLimit(limit: number | undefined): number | undefined {
  return optionalNonNegativeInteger({
    value: limit,
    label: "Runtime signal query limit",
    cause: { limit },
  });
}
