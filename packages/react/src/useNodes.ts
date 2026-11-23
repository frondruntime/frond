import type * as Frond from "@frondruntime/core";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useRuntime } from "./context";
import { assertInsideObserver } from "./developmentChecks";
import {
  assertStableKeySet as assertStableNodeKeySet,
  type PreparedReactNodeMapEntry,
  prepareReactNodeMap,
  type ReactNodeMapEntry,
} from "./nodeInputMap";
import { makeReactNodeStore } from "./nodeStore";
import { makeRevivableStoreSubscriptions } from "./storeSubscriptions";
import { compositeSuspendPromise, type SuspendPromise, type SuspenseRead } from "./suspendPromise";
import type {
  CheckedReactNodeInputMap,
  ReactNodeInputMap,
  ReactNodeRuntime,
  ReactNodeSpec,
  UseNodesResult,
} from "./types";
import { useReadyRead } from "./useReadyRead";

/**
 * Reads several ready Frond nodes as one Suspense unit.
 *
 * The map key set must stay stable. Individual args may update when they keep
 * the same Frond node identity.
 *
 * Call it inside a MobX `observer` component. A plain-data write rerenders the
 * observers that read that node's `result`. A share patch on MobX-observable
 * models notifies only readers of the changed observable fields. Non-observable
 * non-plain values (plain classes, Map, Set, Date) outside observable boundaries
 * still make a share patch notify every `node.result` reader.
 * Runtimes created with `development: true` throw
 * `FrondReactUsageError` on every call outside an observer.
 */
export function useNodes<const TMap extends ReactNodeInputMap>(
  map: TMap & CheckedReactNodeInputMap<TMap>
): UseNodesResult<TMap> {
  return useNodeMap(map, true);
}

/**
 * `useNodes` without the observer check, for a caller that reads no result,
 * such as `Preload`.
 */
export function useNodeMap<const TMap extends ReactNodeInputMap>(
  map: TMap & CheckedReactNodeInputMap<TMap>,
  readsResult: boolean
): UseNodesResult<TMap> {
  const runtime = useRuntime();
  const initialKeys = useRef<ReadonlyArray<string> | undefined>(undefined);
  const prepared = prepareReactNodeMap({ hook: "useNodes", runtime, map });
  if (readsResult && runtime.development) {
    assertInsideObserver(
      "useNodes",
      prepared.entries.map((entry) => entry.spec)
    );
  }

  assertStableNodeKeySet({
    hook: "useNodes",
    initialKeys,
    nextKeys: prepared.keys,
  });

  // Biome cannot see that identity encodes the map's stable key set and node ids.
  // Including map would recreate stores for inline literals with the same Frond keys.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity is the stable Frond set identity.
  const store = useMemo(
    () => makeReactNodesStore(runtime, prepared.entries),
    [runtime, prepared.identity]
  );
  const entriesRef = useRef(prepared.entries);
  entriesRef.current = prepared.entries;
  // The entries the last effect forwarded, and the runtime it forwarded them
  // to. A new key for one entry rebuilds every child store, so the composite
  // compares against these, not against its children, to tell an entry that
  // mounts from an unchanged sibling. Entries forwarded to another runtime do not count: every
  // entry mounts afresh on a new runtime.
  const committedEntriesRef = useRef<ReadonlyArray<ReactNodeStoreEntry> | undefined>(undefined);
  const committedRuntimeRef = useRef<ReactNodeRuntime | undefined>(undefined);

  useEffect(() => () => store.dispose(), [store]);
  // Before the args effect: an Activity reveal runs effects in hook order, and
  // this subscription revives the store the hide disposed, so the args effect
  // after it submits args that changed while hidden.
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // biome-ignore lint/correctness/useExhaustiveDependencies: prepared.argsIdentity stands in for entriesRef.current.
  useEffect(() => {
    const committed =
      committedRuntimeRef.current === runtime ? committedEntriesRef.current : undefined;
    committedEntriesRef.current = entriesRef.current;
    committedRuntimeRef.current = runtime;
    void store.updateArgs(entriesRef.current, committed).catch(() => undefined);
  }, [prepared.argsIdentity, runtime, store]);

  return useReadyRead(store.read) as UseNodesResult<TMap>;
}

export type ReactNodeStoreEntry = ReactNodeMapEntry &
  Partial<Pick<PreparedReactNodeMapEntry, "argsFingerprint">>;

export interface ReactNodesStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getVersion: () => number;
  readonly read: () => SuspenseRead<Record<string, object>>;
  /**
   * Forwards every entry to its child store, which submits the entry's args
   * when they differ from the last args it submitted. Only an entry that is
   * new, or whose node id or args fingerprint differs from the same entry in
   * `committed`, counts as a mount that aligns a node holding other args.
   * Without `committed`, every entry is new.
   */
  readonly updateArgs: (
    entries: ReadonlyArray<ReactNodeStoreEntry>,
    committed?: ReadonlyArray<ReactNodeStoreEntry> | undefined
  ) => Promise<void>;
  readonly dispose: () => void;
}

export function makeReactNodesStore(
  runtime: ReactNodeRuntime,
  entries: ReadonlyArray<ReactNodeStoreEntry>
): ReactNodesStore {
  const stores = entries.map((entry) => ({
    key: entry.key,
    store: makeReactNodeStore<Frond.Key.KeyInput, object, unknown, object>(
      runtime,
      {
        spec: entry.spec as ReactNodeSpec<Frond.Key.KeyInput, object, unknown, object>,
        args: entry.args as Frond.Key.KeyInput,
        nodeId: entry.nodeId,
        argsFingerprint: entry.argsFingerprint,
      },
      "result"
    ),
  }));
  const storeByKey = new Map(stores.map((entry) => [entry.key, entry.store]));
  let childUnsubscribers: ReadonlyArray<() => void> = [];
  let cachedReadyVersion = -1;
  let cachedReadyNodes: Record<string, object> | undefined;
  let updateBuffer: Array<Promise<void>> | undefined = [];

  // Child stores revive themselves on subscribe; the composite must do the
  // same so a StrictMode/Activity effect replay does not leave it dead.
  const subscriptions = makeRevivableStoreSubscriptions({
    attach: () => {
      if (childUnsubscribers.length === 0) {
        childUnsubscribers = stores.map(({ store }) => store.subscribe(subscriptions.emit));
      }
    },
    detach: () => {
      unsubscribeChildren(childUnsubscribers);
      childUnsubscribers = [];
    },
  });

  const read = (): SuspenseRead<Record<string, object>> => {
    if (
      childUnsubscribers.length > 0 &&
      cachedReadyNodes !== undefined &&
      cachedReadyVersion === subscriptions.getVersion()
    ) {
      return { _tag: "Ready", value: cachedReadyNodes };
    }

    const nodes: Record<string, object> = {};
    let pendingAttempts: Array<SuspendPromise> | undefined;

    for (const { key, store } of stores) {
      const child = store.read();
      switch (child._tag) {
        case "Ready":
          nodes[key] = child.value.node;
          break;
        case "Pending":
          pendingAttempts ??= [];
          pendingAttempts.push(child.promise);
          break;
        default: {
          const unreachable: never = child;
          throw unreachable;
        }
      }
    }

    if (pendingAttempts !== undefined) {
      cachedReadyNodes = undefined;
      cachedReadyVersion = -1;
      return { _tag: "Pending", promise: compositeSuspendPromise(pendingAttempts) };
    }

    // Detached reads must validate every child, but unchanged children can
    // still share the previous map identity.
    if (
      cachedReadyNodes === undefined ||
      stores.some(({ key }) => cachedReadyNodes?.[key] !== nodes[key])
    ) {
      cachedReadyNodes = nodes;
    }
    cachedReadyVersion = subscriptions.getVersion();
    return { _tag: "Ready", value: cachedReadyNodes };
  };

  return {
    subscribe: subscriptions.subscribe,
    getVersion: subscriptions.getVersion,
    read,
    updateArgs: async (nextEntries, committed) => {
      cachedReadyNodes = undefined;
      cachedReadyVersion = -1;
      // Reused across calls: `Promise.all` reads it before returning. A call
      // that starts while another fills it takes a fresh array.
      const updates = updateBuffer ?? [];
      updateBuffer = undefined;
      for (let index = 0; index < nextEntries.length; index += 1) {
        const entry = nextEntries[index];
        if (entry === undefined) {
          continue;
        }
        // An unchanged entry is not a mount, even in a child store rebuilt for
        // a sibling's new key: it never pushes its args over another request's,
        // but it still retries its own change that failed.
        const update = storeByKey
          .get(entry.key)
          ?.updateArgs(
            entry.args as Frond.Key.KeyInput,
            entry.argsFingerprint,
            !sameEntry(committed?.[index], entry)
          );
        if (update !== undefined) {
          updates.push(update);
        }
      }
      const settled = Promise.all(updates);
      updates.length = 0;
      updateBuffer = updates;
      await settled;
    },
    dispose: () => {
      if (!subscriptions.dispose()) {
        return;
      }

      for (const { store } of stores) {
        store.dispose();
      }

      cachedReadyNodes = undefined;
      cachedReadyVersion = -1;
    },
  };
}

// An entry without a fingerprint never counts as the same: its child store
// computes one and dedupes the request itself.
function sameEntry(
  committed: ReactNodeStoreEntry | undefined,
  entry: ReactNodeStoreEntry
): boolean {
  return (
    committed !== undefined &&
    committed.key === entry.key &&
    committed.nodeId === entry.nodeId &&
    entry.argsFingerprint !== undefined &&
    committed.argsFingerprint === entry.argsFingerprint
  );
}

function unsubscribeChildren(unsubscribers: ReadonlyArray<() => void>): void {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }
}
