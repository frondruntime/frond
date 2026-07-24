import type { NodeId } from "../types";
import type { GraphNodeCell, GraphPlanState } from "./cellModel";

export type GraphNodeCellLookup =
  | {
      readonly _tag: "Found";
      readonly cell: GraphNodeCell;
    }
  | {
      readonly _tag: "Missing";
      readonly nodeId: NodeId;
    };

export function lookupGraphNodeCell(
  state: Pick<GraphPlanState, "nodes">,
  nodeId: NodeId
): GraphNodeCellLookup {
  const cell = state.nodes.get(nodeId);

  return cell ? { _tag: "Found", cell } : { _tag: "Missing", nodeId };
}
