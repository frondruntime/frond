import type * as Frond from "@frondruntime/core";
import type { NodeSpecArgs, NodeSpecLike, NodeSpecResult } from "@frondruntime/core";
import { useEffect, useMemo, useRef } from "react";
import { getReactArgsFingerprint } from "./argsFingerprint";
import { useRuntime } from "./context";
import { ReactRuntimeMetadata } from "./metadata";
import { assertStableKeySet, prepareReactNodeMap, type ReactNodeMapEntry } from "./nodeInputMap";
import type {
  CheckedReactNodeInputMap,
  ReactNodeInputMap,
  UseNodeControls,
  UseNodesControls,
} from "./types";

/**
 * Returns imperative controls for one node identity without reading the node result.
 *
 * Use for retry/refresh/release/evict buttons. This hook does not make React
 * presence a driver liveness source.
 */
export function useNodeControls<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): UseNodeControls {
  const runtime = useRuntime();
  const nodeId = runtime.resolveNodeIdSync({ spec, args });
  // Biome cannot see that nodeId is the canonical identity for spec and args.
  // Including args would recreate controls for inline object literals with the same Frond key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeId is the stable Frond identity.
  const handle = useMemo(
    () => runtime.client.node<NodeSpecArgs<TSpec>, NodeSpecResult<TSpec>>(spec, args),
    [runtime, nodeId]
  );
  const argsFingerprint = useRef<NodeArgsFingerprint | undefined>(undefined);

  if (argsFingerprint.current === undefined) {
    argsFingerprint.current = {
      nodeId,
      fingerprint: getReactArgsFingerprint(args),
    };
  }

  useEffect(() => {
    const nextArgsFingerprint = getReactArgsFingerprint(args);
    const currentArgsFingerprint = argsFingerprint.current;

    if (currentArgsFingerprint === undefined || currentArgsFingerprint.nodeId !== nodeId) {
      argsFingerprint.current = {
        nodeId,
        fingerprint: nextArgsFingerprint,
      };
      return;
    }

    if (nextArgsFingerprint === currentArgsFingerprint.fingerprint) {
      return;
    }

    dispatchArgsUpdate({
      handle,
      args,
      next: {
        nodeId,
        fingerprint: nextArgsFingerprint,
      },
      previous: currentArgsFingerprint,
      getCurrent: () => argsFingerprint.current,
      setCurrent: (fingerprint) => {
        argsFingerprint.current = fingerprint;
      },
    });
  }, [args, handle, nodeId]);

  return useMemo(() => makeReactNodeControls(handle), [handle]);
}

/**
 * Returns imperative controls for a stable keyed set of node identities.
 */
export function useNodesControls<const TMap extends ReactNodeInputMap>(
  map: TMap & CheckedReactNodeInputMap<TMap>
): UseNodesControls<TMap> {
  const runtime = useRuntime();
  const initialKeys = useRef<ReadonlyArray<string> | undefined>(undefined);
  const argsFingerprints = useRef(new Map<string, NodeArgsFingerprint>());
  const prepared = prepareReactNodeMap({ hook: "useNodesControls", runtime, map });

  assertStableKeySet({
    hook: "useNodesControls",
    initialKeys,
    nextKeys: prepared.keys,
  });

  // Biome cannot see that identity encodes the map's stable key set and node ids.
  // Including map would recreate controls for inline literals with the same Frond keys.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity is the stable Frond set identity.
  const controls = useMemo(
    () => makeReactNodesControls(runtime, prepared.entries),
    [runtime, prepared.identity]
  );

  // Encodes the stable set identity plus each entry's args fingerprint, so the
  // reconciliation effect re-runs only when some entry's args actually change —
  // not on every render (entries is a fresh array reference each time).
  const entriesRef = useRef(prepared.entries);
  entriesRef.current = prepared.entries;

  // biome-ignore lint/correctness/useExhaustiveDependencies: prepared.argsIdentity stands in for entriesRef.current.
  useEffect(() => {
    for (const entry of entriesRef.current) {
      const handle = controls.handleByKey.get(entry.key);

      if (handle === undefined) {
        continue;
      }

      const previousArgsFingerprint = argsFingerprints.current.get(entry.key);
      const next = {
        nodeId: entry.nodeId,
        fingerprint: entry.argsFingerprint,
      };

      if (
        previousArgsFingerprint === undefined ||
        previousArgsFingerprint.nodeId !== entry.nodeId
      ) {
        argsFingerprints.current.set(entry.key, next);
        continue;
      }

      if (entry.argsFingerprint === previousArgsFingerprint.fingerprint) {
        continue;
      }

      dispatchArgsUpdate({
        handle,
        args: entry.args,
        next,
        previous: previousArgsFingerprint,
        getCurrent: () => argsFingerprints.current.get(entry.key),
        setCurrent: (fingerprint) => {
          argsFingerprints.current.set(entry.key, fingerprint);
        },
      });
    }
  }, [controls, prepared.argsIdentity]);

  return controls.controls as UseNodesControls<TMap>;
}

export function makeReactNodeControls(
  handle: Pick<
    Frond.Runtime.RuntimeNodeHandle<unknown, unknown>,
    "nodeId" | "ensureReady" | "refresh" | "evict" | "releaseResources"
  >
): UseNodeControls {
  return {
    nodeId: handle.nodeId,
    ensureReady: async () => {
      await handle.ensureReady(ReactRuntimeMetadata.retry());
    },
    refresh: () => handle.refresh(ReactRuntimeMetadata.refresh()),
    evict: (mode, reason) => handle.evict(mode, reason, ReactRuntimeMetadata.eviction()),
    releaseResources: (reason) => handle.releaseResources(reason, ReactRuntimeMetadata.release()),
  };
}

interface NodeArgsFingerprint {
  readonly nodeId: Frond.Graph.NodeId;
  readonly fingerprint: string;
}

/**
 * Installs `next` in the fingerprint slot and dispatches the args update.
 *
 * On failure it only rolls back if no later updateArgs has overtaken the
 * slot. Otherwise it would clobber a newer (live) fingerprint with the stale
 * `previous` snapshot, and later renders carrying the newer args would be
 * skipped as "already current" while the runtime holds them.
 */
function dispatchArgsUpdate<TArgs>(input: {
  readonly handle: Pick<Frond.Runtime.RuntimeNodeHandle<TArgs, unknown>, "updateArgs">;
  readonly args: TArgs;
  readonly next: NodeArgsFingerprint;
  readonly previous: NodeArgsFingerprint;
  readonly getCurrent: () => NodeArgsFingerprint | undefined;
  readonly setCurrent: (fingerprint: NodeArgsFingerprint) => void;
}): void {
  input.setCurrent(input.next);
  void input.handle.updateArgs(input.args, ReactRuntimeMetadata.argsUpdate()).then((result) => {
    if (result._tag === "Failure" && input.getCurrent() === input.next) {
      input.setCurrent(input.previous);
    }
  });
}

interface ReactNodeControlEntry {
  readonly key: string;
  readonly handle: Frond.Runtime.RuntimeNodeHandle<unknown, unknown>;
  readonly controls: UseNodeControls;
}

interface ReactNodesControlsState {
  readonly entries: ReadonlyArray<ReactNodeControlEntry>;
  readonly handleByKey: ReadonlyMap<string, Frond.Runtime.RuntimeNodeHandle<unknown, unknown>>;
  readonly controls: Record<string, UseNodeControls>;
}

function makeReactNodesControls(
  runtime: Pick<Frond.Runtime.Runtime, "client">,
  entries: ReadonlyArray<ReactNodeMapEntry>
): ReactNodesControlsState {
  const controlEntries = entries.map((entry) => {
    const handle = runtime.client.node<unknown, unknown>(entry.spec, entry.args);

    return {
      key: entry.key,
      handle,
      controls: makeReactNodeControls(handle),
    };
  });
  const controls: Record<string, UseNodeControls> = {};

  for (const entry of controlEntries) {
    controls[entry.key] = entry.controls;
  }

  return {
    entries: controlEntries,
    handleByKey: new Map(controlEntries.map((entry) => [entry.key, entry.handle])),
    controls,
  };
}
