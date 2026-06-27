import type { Dependency, NodeSpecArgs, NodeSpecLike } from "./types";

export function dep<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): Dependency<TSpec> {
  return { type: "dependency", spec, args };
}
