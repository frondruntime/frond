import type {
  NodeSpecArgs,
  NodeSpecDeclaredDeps,
  NodeSpecLike,
  NodeSpecResult,
  Runtime,
} from "@frondruntime/core";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getReactArgsFingerprint } from "./argsFingerprint";
import { useRuntime } from "./context";
import { makeReactNodeStore, type ReactNodeStore } from "./nodeStore";
import type { ReactNodeSpec } from "./types";

/**
 * Internal shared engine of `useNodeState` and `useNodeRead`.
 *
 * Owns everything both hooks have in common: store identity keyed by the
 * canonical node id, the args-fingerprint update gating, dispose-on-unmount,
 * and the external-store subscription. The public hooks are thin tails over
 * the returned store — `read()` (throwing) for `useNodeState`/`useNode`,
 * `peek()` (tagged union) for `useNodeRead`.
 */
export function useReactNodeStore<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): ReactNodeStore<
  NodeSpecArgs<TSpec>,
  NodeSpecDeclaredDeps<TSpec>,
  NodeSpecResult<TSpec>,
  Runtime.RuntimeHandleNode<TSpec>
> {
  const runtime = useRuntime();
  const nodeId = runtime.resolveNodeIdSync({ spec, args });
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
      >(runtime, {
        spec: spec as unknown as ReactNodeSpec<
          NodeSpecArgs<TSpec>,
          NodeSpecDeclaredDeps<TSpec>,
          NodeSpecResult<TSpec>,
          Runtime.RuntimeHandleNode<TSpec>
        >,
        args,
        nodeId,
      }),
    [runtime, nodeId]
  );

  const argsFingerprint = getReactArgsFingerprint(args);
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => () => store.dispose(), [store]);
  // Gate on the args fingerprint, not nodeId: a fresh object literal of equal
  // args must not re-run the effect, but a genuine same-identity arg change must.
  // biome-ignore lint/correctness/useExhaustiveDependencies: argsFingerprint stands in for argsRef.current.
  useEffect(() => {
    void store.updateArgs(argsRef.current).catch(() => undefined);
  }, [argsFingerprint, store]);
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  return store;
}
