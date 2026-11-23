import type {
  NodeSpecArgs,
  NodeSpecDeclaredDeps,
  NodeSpecLike,
  NodeSpecResult,
  Runtime,
} from "@frondruntime/core";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { resolveReactNodeIdentity, validatedNodeIdResolver } from "./argsFingerprint";
import { useRuntime } from "./context";
import { makeReactNodeStore, type ReactNodeStore, type ReactNodeStoreMode } from "./nodeStore";
import type { ReactNodeSpec } from "./types";

/**
 * Internal shared engine of `useNode`, `useNodeState` and `useNodeRead`.
 *
 * Owns everything both hooks have in common: store identity keyed by the
 * canonical node id, the args-fingerprint update gating, dispose-on-unmount,
 * and the external-store subscription. The public hooks are thin tails over
 * the returned store — `read()` (ready state or pending promise) for `useNodeState`/`useNode`,
 * `peek()` (tagged union) for `useNodeRead`.
 */
export function useReactNodeStore<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>,
  mode: ReactNodeStoreMode = "status"
): ReactNodeStore<
  NodeSpecArgs<TSpec>,
  NodeSpecDeclaredDeps<TSpec>,
  NodeSpecResult<TSpec>,
  Runtime.RuntimeHandleNode<TSpec>
> {
  const runtime = useRuntime();
  const resolveValidated = validatedNodeIdResolver(runtime);
  const { nodeId, argsFingerprint } = resolveReactNodeIdentity(
    runtime,
    { spec, args },
    resolveValidated
  );
  // Biome cannot see that nodeId is the canonical identity for spec and args.
  // Including args would recreate the store for inline object literals with the same Frond key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeId is the stable Frond identity.
  const store = useMemo(
    () =>
      makeReactNodeStore<
        NodeSpecArgs<TSpec>,
        NodeSpecDeclaredDeps<TSpec>,
        NodeSpecResult<TSpec>,
        Runtime.RuntimeHandleNode<TSpec>
      >(
        runtime,
        {
          spec: spec as unknown as ReactNodeSpec<
            NodeSpecArgs<TSpec>,
            NodeSpecDeclaredDeps<TSpec>,
            NodeSpecResult<TSpec>,
            Runtime.RuntimeHandleNode<TSpec>
          >,
          args,
          nodeId,
          argsFingerprint,
        },
        mode
      ),
    [runtime, nodeId, mode]
  );

  // Written together each render, so the effect reads a matching pair.
  const argsRef = useRef(args);
  argsRef.current = args;
  const argsFingerprintRef = useRef(argsFingerprint);
  argsFingerprintRef.current = argsFingerprint;

  useEffect(() => () => store.dispose(), [store]);
  // Before the args effect: an Activity reveal runs effects in hook order, and
  // this subscription revives the store the hide disposed, so the args effect
  // after it submits args that changed while hidden.
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // Gate on the args fingerprint, not nodeId: a fresh object literal of equal
  // args must not re-run the effect, but a genuine same-identity arg change must.
  // biome-ignore lint/correctness/useExhaustiveDependencies: argsFingerprint stands in for argsRef.current.
  useEffect(() => {
    void store.updateArgs(argsRef.current, argsFingerprintRef.current).catch(() => undefined);
  }, [argsFingerprint, store]);

  return store;
}
