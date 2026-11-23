import type { NodeSpecArgs, NodeSpecLike, NodeSpecResult, Runtime } from "@frondruntime/core";
import { useReactNodeStore } from "./useReactNodeStore";

/**
 * Reads a Frond node without suspending or throwing to an error boundary.
 *
 * The complement to `useNode`/`useNodeState`: those suspend through React's `use()`
 * at the nearest Suspense boundary and throw readiness failures to the nearest
 * error boundary. `useNodeRead` instead returns the
 * runtime read as a tagged union for the caller to `Match` on — use it when a
 * component must render Pending/Error inline (an accessible fallback that never
 * blanks and never falls through) rather than delegate to a boundary.
 *
 * It still drives the same cold-start readiness boot and subscribes to changes,
 * so the node makes progress exactly as it would under the Suspense hooks.
 */
export function useNodeRead<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): Runtime.RuntimeNodeRead<NodeSpecResult<TSpec>, Runtime.RuntimeHandleNode<TSpec>> {
  return useReactNodeStore(spec, args).peek();
}
