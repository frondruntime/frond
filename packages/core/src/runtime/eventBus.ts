import { Clock, Effect } from "effect";
import { classify, failures, nodeIds } from "../events";
import { effectBoundaryFailed } from "../graph/driverExecution/effectBoundary";
import { optionalNonNegativeInteger } from "./limits";
import { withRuntimeSpan } from "./observability";
import type {
  RuntimeEvent,
  RuntimeEventRecord,
  RuntimeId,
  RuntimeObserver,
  RuntimeSink,
} from "./types";
import { type RuntimeWorkContext, runtimeWorkAttributes } from "./work";

export interface RuntimeEventBus {
  readonly emit: (
    event: RuntimeEvent,
    work?: RuntimeWorkContext | undefined
  ) => Effect.Effect<void>;
  readonly observe: (
    observer: RuntimeObserver
  ) => Effect.Effect<{ readonly unsubscribe: () => void }>;
  readonly events: (limit?: number) => ReadonlyArray<RuntimeEventRecord>;
  readonly sinks: () => ReadonlyArray<string>;
}

export interface RuntimeEventBusConfig {
  readonly runtimeId: RuntimeId;
  readonly eventBufferSize: number;
  readonly sinks: ReadonlyArray<RuntimeSink>;
  readonly fallbackWork: () => RuntimeWorkContext;
}

export const makeRuntimeEventBus = (config: RuntimeEventBusConfig): RuntimeEventBus => {
  const runtimeId = config.runtimeId;
  const sinks = config.sinks;
  const observers = new Set<RuntimeObserver>();
  // Snapshot of `observers`, rebuilt only on subscribe/unsubscribe so each emit
  // iterates a stable array without copying the Set. Replacing (not mutating) the
  // array keeps in-flight notifications safe against concurrent (un)subscription.
  let observerList: ReadonlyArray<RuntimeObserver> = [];
  const events: Array<RuntimeEventRecord> = [];
  let sequence = 0;

  const remember = (
    event: RuntimeEvent,
    recordedAt: number,
    work: RuntimeWorkContext
  ): RuntimeEventRecord => {
    sequence += 1;
    const record: RuntimeEventRecord = {
      runtimeId,
      sequence,
      recordedAt,
      work,
      event,
      classification: classify(event),
      nodeIds: nodeIds(event),
      failures: failures(event),
    };

    // Zero-retention contract: with eventBufferSize 0 a record must never
    // enter the retained array, not even transiently between a push and a
    // trim. Observers and sinks still receive every record.
    if (config.eventBufferSize > 0) {
      events.push(record);

      if (events.length > config.eventBufferSize) {
        events.splice(0, events.length - config.eventBufferSize);
      }
    }

    return record;
  };

  const notifyObservers = (
    record: RuntimeEventRecord,
    observerFailureDepth = 0
  ): Effect.Effect<void> =>
    observerList.length === 0
      ? Effect.void
      : Effect.forEach(
          observerList,
          (observer) =>
            Effect.sync(() => observerFailure(observer, record)).pipe(
              Effect.flatMap((cause) =>
                cause === undefined
                  ? Effect.void
                  : recordObserverFailure(
                      record.event._tag,
                      cause,
                      record.work,
                      observerFailureDepth
                    )
              )
            ),
          { concurrency: 1, discard: true }
        );

  const notifySinks = (
    record: RuntimeEventRecord,
    observerFailureDepth = 0
  ): Effect.Effect<void> =>
    sinks.length === 0
      ? Effect.void
      : Effect.forEach(
          sinks,
          (sink) =>
            withRuntimeSpan(
              Effect.suspend(() => sink.handle(record)),
              "frond.runtime.sink.emit",
              {
                "frond.runtime.id": runtimeId,
                "frond.runtime.sink": sink.name,
                "frond.runtime.event": record.event._tag,
                ...runtimeWorkAttributes(record.work),
              }
            ).pipe(
              Effect.catchCause((cause) =>
                recordSinkFailure(
                  sink.name,
                  record.event._tag,
                  effectBoundaryFailed("runtime-sink", cause),
                  record.work,
                  observerFailureDepth
                )
              )
            ),
          { concurrency: "unbounded" }
        ).pipe(Effect.asVoid);

  const recordObserverFailure = (
    eventTag: RuntimeEvent["_tag"],
    cause: unknown,
    work: RuntimeWorkContext,
    observerFailureDepth: number
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const record = remember(
        { _tag: "RuntimeObserverFailureObserved", eventTag, cause, at },
        at,
        work
      );

      if (observerFailureDepth > 0) {
        return;
      }

      yield* notifySinks(record, observerFailureDepth + 1);
    });

  const recordSinkFailure = (
    sink: string,
    eventTag: RuntimeEvent["_tag"],
    cause: unknown,
    work: RuntimeWorkContext,
    observerFailureDepth: number
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const failure = {
        _tag: "RuntimeSinkFailureObserved",
        sink,
        eventTag,
        cause,
        at,
      } satisfies RuntimeEvent;
      const record = remember(failure, at, work);

      yield* notifyObservers(record, observerFailureDepth);
    });

  const emit = (
    event: RuntimeEvent,
    work: RuntimeWorkContext | undefined = config.fallbackWork()
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const recordedAt = yield* Clock.currentTimeMillis;
      const record = yield* Effect.sync(() => remember(event, recordedAt, work));

      yield* notifyObservers(record);
      yield* notifySinks(record);
    });

  return {
    emit,
    observe: (observer) =>
      Effect.sync(() => {
        observers.add(observer);
        observerList = [...observers];

        return {
          unsubscribe: () => {
            observers.delete(observer);
            observerList = [...observers];
          },
        };
      }),
    events: (limit) => {
      const normalizedLimit = eventQueryLimit(limit);

      if (normalizedLimit === undefined) {
        return [...events];
      }

      return normalizedLimit === 0 ? [] : events.slice(-normalizedLimit);
    },
    sinks: () => sinks.map((sink) => sink.name),
  };
};

function observerFailure(
  observer: RuntimeObserver,
  record: RuntimeEventRecord
): unknown | undefined {
  try {
    observer(record);
    return undefined;
  } catch (cause) {
    return cause;
  }
}

function eventQueryLimit(limit: number | undefined): number | undefined {
  return optionalNonNegativeInteger({
    value: limit,
    label: "Runtime event query limit",
    cause: { limit },
  });
}
