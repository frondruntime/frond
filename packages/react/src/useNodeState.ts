import type {
  NodeSpecArgs,
  NodeSpecDeclaredDeps,
  NodeSpecInstance,
  NodeSpecLike,
  NodeSpecResult,
} from "@frondruntime/core";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getReactArgsFingerprint } from "./argsFingerprint";
import { useRuntime } from "./context";
import { makeReactNodeStore } from "./nodeStore";
import type { ReactNodeSpec, UseNodeState } from "./types";

/**
 * Reads the ready node plus runtime operation metadata.
 *
 * Use when UI needs busy/result-validity/operation failure state. Product reads
 * still use the ready node instance, not full runtime snapshots.
 */
export function useNodeState<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): UseNodeState<TSpec> {
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
        ReactSpecInstance<TSpec>
      >(runtime, {
        spec: spec as unknown as ReactNodeSpec<
          NodeSpecArgs<TSpec>,
          NodeSpecDeclaredDeps<TSpec>,
          NodeSpecResult<TSpec>,
          ReactSpecInstance<TSpec>
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
    void store.updateArgs(argsRef.current);
  }, [argsFingerprint, store]);
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  return store.read() as UseNodeState<TSpec>;
}

type ReactSpecInstance<TSpec> =
  NodeSpecInstance<TSpec> extends object ? NodeSpecInstance<TSpec> : object;
