/**
 * Listener and lifecycle bookkeeping shared by the React node stores.
 *
 * React StrictMode and Activity replay effect cleanup and setup on the same
 * fiber without re-running useMemo. The replayed cleanup disposes the store,
 * and the replayed setup then subscribes on that same disposed instance.
 * `subscribe` therefore revives a disposed store so the replayed subscription
 * registers a live listener instead of a dead no-op that would freeze the
 * store's version forever.
 */
export interface RevivableStoreSubscriptions {
  readonly subscribe: (listener: () => void) => () => void;
  readonly emit: () => void;
  readonly getVersion: () => number;
  readonly isDisposed: () => boolean;
  /** Returns false when the store was already disposed. */
  readonly dispose: () => boolean;
}

export function makeRevivableStoreSubscriptions(wiring: {
  /** Wires the upstream subscription when the first listener arrives. */
  readonly attach: () => void;
  /** Unwires the upstream subscription when the last listener leaves. */
  readonly detach: () => void;
}): RevivableStoreSubscriptions {
  const listeners = new Set<() => void>();
  let version = 0;
  let disposed = false;

  return {
    subscribe: (listener) => {
      if (disposed) {
        disposed = false;
      }

      const isFirstListener = listeners.size === 0;

      listeners.add(listener);

      if (isFirstListener) {
        wiring.attach();
      }

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) {
          wiring.detach();
        }
      };
    },
    emit: () => {
      if (disposed) {
        return;
      }

      version += 1;

      for (const listener of listeners) {
        listener();
      }
    },
    getVersion: () => version,
    isDisposed: () => disposed,
    dispose: () => {
      if (disposed) {
        return false;
      }

      disposed = true;
      listeners.clear();
      wiring.detach();
      return true;
    },
  };
}
