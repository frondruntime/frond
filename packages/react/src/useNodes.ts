import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useRuntime } from "./context";
import {
  assertStableKeySet as assertStableNodeKeySet,
  prepareReactNodeMap,
  type ReactNodeMapEntry,
} from "./nodeInputMap";
import { makeReactNodeStore } from "./nodeStore";
import { makeRevivableStoreSubscriptions } from "./storeSubscriptions";
import type {
  CheckedReactNodeInputMap,
  ReactNodeInputMap,
  ReactNodeRuntime,
  ReactNodeSpec,
  UseNodesResult,
} from "./types";

/**
 * Reads several ready Frond nodes as one Suspense unit.
 *
 * The map key set must stay stable. Individual args may update when they keep
 * the same Frond node identity.
 */
export function useNodes<const TMap extends ReactNodeInputMap>(
  map: TMap & CheckedReactNodeInputMap<TMap>
): UseNodesResult<TMap> {
  const runtime = useRuntime();
  const initialKeys = useRef<ReadonlyArray<string> | undefined>(undefined);
  const prepared = prepareReactNodeMap({ hook: "useNodes", runtime, map });

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

  useEffect(() => () => store.dispose(), [store]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: prepared.argsIdentity stands in for entriesRef.current.
  useEffect(() => {
    void store.updateArgs(entriesRef.current);
  }, [prepared.argsIdentity, store]);
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  return store.read() as UseNodesResult<TMap>;
}

export type ReactNodeStoreEntry = ReactNodeMapEntry;

export interface ReactNodesStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getVersion: () => number;
  readonly read: () => Record<string, object>;
  readonly updateArgs: (entries: ReadonlyArray<ReactNodeStoreEntry>) => Promise<void>;
  readonly dispose: () => void;
}

export function makeReactNodesStore(
  runtime: ReactNodeRuntime,
  entries: ReadonlyArray<ReactNodeStoreEntry>
): ReactNodesStore {
  const stores = entries.map((entry) => ({
    key: entry.key,
    store: makeReactNodeStore<unknown, object, unknown, object>(runtime, {
      spec: entry.spec as ReactNodeSpec<unknown, object, unknown, object>,
      args: entry.args,
      nodeId: entry.nodeId,
    }),
  }));
  const storeByKey = new Map(stores.map((entry) => [entry.key, entry.store]));
  let childUnsubscribers: ReadonlyArray<() => void> = [];
  let pending: PendingCompositeAttempt | undefined;
  let cachedReadyVersion = -1;
  let cachedReadyNodes: Record<string, object> | undefined;

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

  const read = (): Record<string, object> => {
    if (cachedReadyNodes !== undefined && cachedReadyVersion === subscriptions.getVersion()) {
      return cachedReadyNodes;
    }

    const nodes: Record<string, object> = {};
    let pendingAttempts: Array<Promise<unknown>> | undefined;

    for (const { key, store } of stores) {
      try {
        nodes[key] = store.read().node;
      } catch (thrown) {
        if (thrown instanceof Promise) {
          pendingAttempts ??= [];
          pendingAttempts.push(thrown);
        } else {
          throw thrown;
        }
      }
    }

    if (pendingAttempts !== undefined) {
      cachedReadyNodes = undefined;
      cachedReadyVersion = -1;
      throw stableCompositeAttempt(pending, pendingAttempts, (next) => {
        pending = next;
      });
    }

    pending = undefined;
    cachedReadyNodes = nodes;
    cachedReadyVersion = subscriptions.getVersion();
    return nodes;
  };

  return {
    subscribe: subscriptions.subscribe,
    getVersion: subscriptions.getVersion,
    read,
    updateArgs: async (nextEntries) => {
      cachedReadyNodes = undefined;
      cachedReadyVersion = -1;
      await Promise.all(
        nextEntries.map((entry) => {
          return storeByKey.get(entry.key)?.updateArgs(entry.args) ?? Promise.resolve();
        })
      );
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

interface PendingCompositeAttempt {
  readonly attempts: ReadonlyArray<Promise<unknown>>;
  readonly promise: Promise<unknown>;
}

function stableCompositeAttempt(
  current: PendingCompositeAttempt | undefined,
  attempts: ReadonlyArray<Promise<unknown>>,
  setCurrent: (attempt: PendingCompositeAttempt) => void
): Promise<unknown> {
  if (current !== undefined && sameAttempts(current.attempts, attempts)) {
    return current.promise;
  }

  const next = {
    attempts,
    promise: Promise.all(attempts),
  };
  setCurrent(next);
  return next.promise;
}

function sameAttempts(
  left: ReadonlyArray<Promise<unknown>>,
  right: ReadonlyArray<Promise<unknown>>
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => entry === right[index]);
}

function unsubscribeChildren(unsubscribers: ReadonlyArray<() => void>): void {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }
}
