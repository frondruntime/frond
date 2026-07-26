import type {
  NodeSpecArgs,
  NodeSpecInstance,
  NodeSpecLike,
  NodeSpecResult,
  Runtime,
} from "@frondruntime/core";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getReactArgsFingerprint } from "./argsFingerprint";
import { useRuntime } from "./context";
import { makeReactNodeStore } from "./nodeStore";
import type { ReactNodeSpec } from "./types";

/**
 * Reads a Frond node without throwing to Suspense or an error boundary.
 *
 * The complement to `useNode`/`useNodeState`: those throw Pending to the nearest
 * Suspense boundary and readiness failures to the nearest error boundary, which
 * is right for content that should suspend. `useNodeRead` instead returns the
 * runtime read as a tagged union for the caller to `Match` on — use it when a
 * component must render Pending/Error inline (an accessible fallback that never
 * blanks and never falls through) rather than delegate to a boundary.
 *
 * It still drives the same cold-start readiness boot and subscribes to changes,
 * so the node makes progress exactly as it would under the throwing hooks.
 */
export function useNodeRead<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): Runtime.RuntimeNodeRead<NodeSpecResult<TSpec>, ReadNodeInstance<TSpec>> {
  const runtime = useRuntime();
  const nodeId = runtime.resolveNodeIdSync({ spec, args });
  // Biome cannot see that nodeId is the canonical identity for spec and args.
  // Including args would recreate the store for inline object literals with the same Frond key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeId is the stable Frond identity.
  const store = useMemo(
    () =>
      makeReactNodeStore<
        NodeSpecArgs<TSpec>,
        never,
        NodeSpecResult<TSpec>,
        ReadNodeInstance<TSpec>
      >(runtime, {
        spec: spec as unknown as ReactNodeSpec<
          NodeSpecArgs<TSpec>,
          never,
          NodeSpecResult<TSpec>,
          ReadNodeInstance<TSpec>
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

  return store.peek();
}

// The ready author-node instance the Ready arm exposes; falls back to `object`
// for opaque spec carriers whose instance type is not statically recoverable.
type ReadNodeInstance<TSpec> =
  NodeSpecInstance<TSpec> extends object ? NodeSpecInstance<TSpec> : object;
