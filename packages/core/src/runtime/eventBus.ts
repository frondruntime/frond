import { Effect } from "effect";
import { classify, failures, nodeIds } from "../events";
import type { NodeId } from "../graph";
import { effectBoundaryFailed } from "../graph/driverExecution/effectBoundary";
import { optionalNonNegativeInteger } from "./limits";
import { withRuntimeSpan } from "./observability";
import type {
  RuntimeEvent,
  RuntimeEventRecord,
  RuntimeId,
  RuntimeObserver,
  RuntimeSink,
  RuntimeSyncClock,
} from "./types";
import { type RuntimeWorkContext, runtimeWorkAttributes } from "./work";

export interface RuntimeEventBus {
  readonly observeSync: (
    observer: RuntimeObserver,
    nodeId?: NodeId
  ) => { readonly unsubscribe: () => void };
  readonly emit: (
    event: RuntimeEvent,
    work?: RuntimeWorkContext | undefined
  ) => Effect.Effect<void>;
  /** As `emit`, for the stop's own events: its sinks start after `closeSinks`. */
  readonly emitClosing: (event: RuntimeEvent, work: RuntimeWorkContext) => Effect.Effect<void>;
  /**
   * From now on `emit` still records an event and notifies every listener,
   * but starts no sink, and a listener that throws records nothing. This holds
   * for work already queued: a sink an earlier `emit` queued checks when it
   * would start, so none starts once this has run.
   */
  readonly closeSinks: () => void;
  readonly observe: (
    observer: RuntimeObserver,
    nodeId?: NodeId
  ) => Effect.Effect<{ readonly unsubscribe: () => void }>;
  readonly events: (limit?: number) => ReadonlyArray<RuntimeEventRecord>;
  readonly sinks: () => ReadonlyArray<string>;
}

export interface RuntimeEventBusConfig {
  readonly runtimeId: RuntimeId;
  readonly eventBufferSize: number;
  readonly sinks: ReadonlyArray<RuntimeSink>;
  readonly syncClock: RuntimeSyncClock;
  readonly fallbackWork: () => RuntimeWorkContext;
}

export const makeRuntimeEventBus = (config: RuntimeEventBusConfig): RuntimeEventBus => {
  const runtimeId = config.runtimeId;
  const sinks = config.sinks;
  type ObserverEntry = {
    readonly observer: RuntimeObserver;
    readonly nodeId: NodeId | undefined;
    // Registration rank: a node's delivery list interleaves its entries with
    // the global entries by this rank.
    readonly order: number;
  };
  // Mutable registrations, one per observer function. `Map.set` on a known
  // observer keeps its first position, so re-registration keeps its order.
  const registrations = new Map<RuntimeObserver, ObserverEntry>();
  const globalEntries = new Map<RuntimeObserver, ObserverEntry>();
  const nodeEntries = new Map<NodeId, Map<RuntimeObserver, ObserverEntry>>();
  let nextOrder = 0;

  // Immutable delivery snapshots, built on the first dispatch after a change
  // and dropped by the change, so a subscription costs O(1) and a dispatch in
  // flight keeps the list it started with. Node lists include global observers
  // in registration order; multi-node records use the full list.
  let fullSnapshot: ReadonlyArray<ObserverEntry> | undefined;
  let globalSnapshot: ReadonlyArray<ObserverEntry> | undefined;
  const nodeSnapshots = new Map<NodeId, ReadonlyArray<ObserverEntry>>();

  const fullList = (): ReadonlyArray<ObserverEntry> => {
    if (fullSnapshot === undefined) fullSnapshot = Array.from(registrations.values());
    return fullSnapshot;
  };

  const globalList = (): ReadonlyArray<ObserverEntry> => {
    if (globalSnapshot === undefined) globalSnapshot = Array.from(globalEntries.values());
    return globalSnapshot;
  };

  const nodeList = (nodeId: NodeId): ReadonlyArray<ObserverEntry> => {
    const cached = nodeSnapshots.get(nodeId);
    if (cached !== undefined) return cached;
    const bucket = nodeEntries.get(nodeId);
    if (bucket === undefined) return globalList();
    const globals = globalList();
    const list: Array<ObserverEntry> = [];
    let globalIndex = 0;
    for (const entry of bucket.values()) {
      while (globalIndex < globals.length) {
        const global = globals[globalIndex] as ObserverEntry;
        if (global.order > entry.order) break;
        list.push(global);
        globalIndex += 1;
      }
      list.push(entry);
    }
    while (globalIndex < globals.length) {
      list.push(globals[globalIndex] as ObserverEntry);
      globalIndex += 1;
    }
    nodeSnapshots.set(nodeId, list);
    return list;
  };

  const bucketOf = (nodeId: NodeId | undefined): Map<RuntimeObserver, ObserverEntry> => {
    if (nodeId === undefined) return globalEntries;
    let bucket = nodeEntries.get(nodeId);
    if (bucket === undefined) {
      bucket = new Map();
      nodeEntries.set(nodeId, bucket);
    }
    return bucket;
  };

  // A global change reaches every node list; a node change reaches its own.
  const invalidate = (nodeId: NodeId | undefined): void => {
    fullSnapshot = undefined;
    if (nodeId === undefined) {
      globalSnapshot = undefined;
      nodeSnapshots.clear();
    } else {
      nodeSnapshots.delete(nodeId);
    }
  };

  const removeEntry = (entry: ObserverEntry): void => {
    if (entry.nodeId === undefined) {
      globalEntries.delete(entry.observer);
    } else {
      const bucket = nodeEntries.get(entry.nodeId);
      if (bucket !== undefined) {
        bucket.delete(entry.observer);
        if (bucket.size === 0) nodeEntries.delete(entry.nodeId);
      }
    }
    invalidate(entry.nodeId);
  };

  // Rare path: a known observer re-registered under another nodeId keeps its
  // first rank, so it may belong before entries already in the target bucket.
  const insertInOrder = (entry: ObserverEntry): void => {
    const bucket = bucketOf(entry.nodeId);
    const entries = Array.from(bucket.values());
    entries.push(entry);
    entries.sort(byOrder);
    bucket.clear();
    for (const sorted of entries) bucket.set(sorted.observer, sorted);
    invalidate(entry.nodeId);
  };

  const register = (observer: RuntimeObserver, nodeId: NodeId | undefined): void => {
    const existing = registrations.get(observer);
    if (existing === undefined) {
      nextOrder += 1;
      const entry: ObserverEntry = { observer, nodeId, order: nextOrder };
      registrations.set(observer, entry);
      bucketOf(nodeId).set(observer, entry);
      invalidate(nodeId);
      return;
    }
    if (existing.nodeId === nodeId) return;
    const entry: ObserverEntry = { observer, nodeId, order: existing.order };
    registrations.set(observer, entry);
    removeEntry(existing);
    insertInOrder(entry);
  };

  const unregister = (observer: RuntimeObserver): void => {
    const entry = registrations.get(observer);
    if (entry === undefined) return;
    registrations.delete(observer);
    removeEntry(entry);
  };
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

  // Set by the stop's sweep: a sink started after it would outlive the stop.
  // Read when a sink would start, not when its delivery is queued, so work the
  // sweep does not own (a signal publication) starts no sink after it either.
  // `closing` marks the stop's own events, whose sinks it awaits.
  let sinksClosed = false;

  const notifyObservers = (
    record: RuntimeEventRecord,
    observerFailureDepth: number,
    closing: boolean,
    list = record.nodeIds.length === 0
      ? globalList()
      : record.nodeIds.length === 1
        ? nodeList(record.nodeIds[0] as NodeId)
        : fullList(),
    start = 0
  ): Effect.Effect<void> => {
    for (let index = start; index < list.length; index += 1) {
      const entry = list[index];
      if (
        entry === undefined ||
        (record.nodeIds.length > 1 &&
          entry.nodeId !== undefined &&
          !record.nodeIds.includes(entry.nodeId))
      )
        continue;
      const cause = observerFailure(entry.observer, record);
      if (cause !== undefined) {
        const pending = recordObserverFailure(
          record.event._tag,
          cause,
          record.work,
          observerFailureDepth,
          closing
        );
        if (pending !== Effect.void) {
          return pending.pipe(
            Effect.flatMap(() =>
              notifyObservers(record, observerFailureDepth, closing, list, index + 1)
            )
          );
        }
      }
    }
    return Effect.void;
  };

  const deliverToSink = (
    sink: RuntimeSink,
    record: RuntimeEventRecord,
    observerFailureDepth: number,
    closing: boolean
  ): Effect.Effect<void> =>
    withRuntimeSpan(
      Effect.suspend(() => (closing || !sinksClosed ? sink.handle(record) : Effect.void)),
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
          observerFailureDepth,
          closing
        )
      )
    );

  const notifySinks = (
    record: RuntimeEventRecord,
    observerFailureDepth: number,
    closing: boolean
  ): Effect.Effect<void> => {
    const first = sinks[0];
    if (first === undefined) return Effect.void;
    if (sinks.length === 1) return deliverToSink(first, record, observerFailureDepth, closing);
    return Effect.forEach(
      sinks,
      (sink) => deliverToSink(sink, record, observerFailureDepth, closing),
      {
        concurrency: "unbounded",
        discard: true,
      }
    );
  };

  const recordObserverFailure = (
    eventTag: RuntimeEvent["_tag"],
    cause: unknown,
    work: RuntimeWorkContext,
    observerFailureDepth: number,
    closing: boolean
  ): Effect.Effect<void> => {
    // A listener failure after the sweep is a late diagnostic: it is dropped,
    // so the listeners behind it run at once.
    if (!closing && sinksClosed) return Effect.void;
    const at = config.syncClock.now();
    const record = remember(
      { _tag: "RuntimeObserverFailureObserved", eventTag, cause, at },
      at,
      work
    );
    return observerFailureDepth > 0
      ? Effect.void
      : notifySinks(record, observerFailureDepth + 1, closing);
  };

  const recordSinkFailure = (
    sink: string,
    eventTag: RuntimeEvent["_tag"],
    cause: unknown,
    work: RuntimeWorkContext,
    observerFailureDepth: number,
    closing: boolean
  ): Effect.Effect<void> => {
    const at = config.syncClock.now();
    const record = remember(
      { _tag: "RuntimeSinkFailureObserved", sink, eventTag, cause, at },
      at,
      work
    );
    // A sink that failed after the sweep still reaches every listener, but a
    // listener that throws on it starts no sink.
    return notifyObservers(record, observerFailureDepth, closing);
  };

  // Dispatch is synchronous. The shared void result allocates nothing; only
  // installed Effect sinks (including observer-failure delivery) return work
  // the Effect caller must await before continuing to the next event. Once the
  // sinks are closed, an ordinary event's work is void: every listener has run,
  // no sink starts, and no listener failure waits on one.
  const dispatch = (
    event: RuntimeEvent,
    work: RuntimeWorkContext | undefined,
    closing: boolean
  ): Effect.Effect<void> => {
    if (registrations.size === 0 && sinks.length === 0 && config.eventBufferSize === 0) {
      sequence += 1;
      return Effect.void;
    }
    const record = remember(event, config.syncClock.now(), work ?? config.fallbackWork());
    const pending = notifyObservers(record, 0, closing);
    if (!closing && sinksClosed) return Effect.void;
    return pending === Effect.void
      ? notifySinks(record, 0, closing)
      : pending.pipe(Effect.flatMap(() => notifySinks(record, 0, closing)));
  };

  const emit = (event: RuntimeEvent, work?: RuntimeWorkContext): Effect.Effect<void> =>
    dispatch(event, work, false);
  const emitClosing = (event: RuntimeEvent, work: RuntimeWorkContext): Effect.Effect<void> =>
    dispatch(event, work, true);
  const closeSinks = (): void => {
    sinksClosed = true;
  };

  const observeSync: RuntimeEventBus["observeSync"] = (observer, nodeId) => {
    register(observer, nodeId);
    return {
      unsubscribe: () => {
        unregister(observer);
      },
    };
  };
  return {
    emit,
    emitClosing,
    closeSinks,
    observeSync,
    observe: (observer, nodeId) => Effect.sync(() => observeSync(observer, nodeId)),
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

function byOrder(left: { readonly order: number }, right: { readonly order: number }): number {
  return left.order - right.order;
}

function eventQueryLimit(limit: number | undefined): number | undefined {
  return optionalNonNegativeInteger({
    value: limit,
    label: "Runtime event query limit",
    cause: { limit },
  });
}
