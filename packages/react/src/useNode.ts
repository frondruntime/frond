import type { NodeSpecArgs, NodeSpecLike } from "@frondruntime/core";
import type { ReadyReactNode } from "./types";
import { useReactNodeStore } from "./useReactNodeStore";

/**
 * Reads a ready Frond node for React rendering.
 *
 * Pending readiness throws Suspense and readiness failures throw ErrorBoundary
 * errors. Only the ready path exposes the author node instance.
 */
export function useNode<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): ReadyReactNode<TSpec> {
  return useReactNodeStore(spec, args, "result").read().node as ReadyReactNode<TSpec>;
}
