import type { NodeId, NodeKey } from "../types";

export function makeNodeId(tag: string, key: NodeKey): NodeId {
  return `${tag}:${key}` as NodeId;
}
