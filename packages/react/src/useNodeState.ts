import type { NodeSpecArgs, NodeSpecLike } from "@frondruntime/core";
import type { UseNodeState } from "./types";
import { useReactNodeStore } from "./useReactNodeStore";

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
  return useReactNodeStore(spec, args).read() as UseNodeState<TSpec>;
}
