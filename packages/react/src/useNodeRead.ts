import type { NodeSpecArgs, NodeSpecLike, NodeSpecResult, Runtime } from "@frondruntime/core";
import { useReactNodeStore } from "./useReactNodeStore";

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
): Runtime.RuntimeNodeRead<NodeSpecResult<TSpec>, Runtime.RuntimeHandleNode<TSpec>> {
  return useReactNodeStore(spec, args).peek();
}
