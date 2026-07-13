import type { RuntimeReadyNodeConstruction } from "../../node/runtime";
import { withReadyNodeConstruction } from "../../node/runtime";
import type { NodeId, NodeRequest } from "../types";
import { GraphInvariantViolation, NodeConstructionFailed } from "../types";
import { type GraphOutcome, graphFailure, graphSuccess } from "./outcome";

export function constructReadyNode(
  request: NodeRequest,
  context: {
    readonly nodeId: NodeId;
    readonly tag: string;
    readonly construction: RuntimeReadyNodeConstruction<unknown, object, unknown>;
  }
): GraphOutcome<object, NodeConstructionFailed> {
  const NodeSpec = request.spec as new () => object;

  try {
    const node = withReadyNodeConstruction(context.construction, () => new NodeSpec());

    if (!(node instanceof NodeSpec)) {
      return graphFailure(
        new NodeConstructionFailed({
          nodeId: context.nodeId,
          tag: context.tag,
          cause: new GraphInvariantViolation({
            nodeId: context.nodeId,
            tag: context.tag,
            invariant: "constructor result must be an instance of the node spec",
          }),
        })
      );
    }

    return graphSuccess(node);
  } catch (cause) {
    return graphFailure(
      new NodeConstructionFailed({
        nodeId: context.nodeId,
        tag: context.tag,
        cause,
      })
    );
  }
}
