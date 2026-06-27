import { Effect } from "effect";
import type { RuntimeActionExecutor } from "../../node";
import type { ActionResult, NodeId } from "../types";

export type NodeActionRunner = (
  nodeId: NodeId,
  action: string,
  input: unknown
) => Effect.Effect<ActionResult>;

/** Bridges graph-native action execution to the Promise API exposed by user node methods. */
export function bridgeNodeActionRunner(
  runAction: NodeActionRunner,
  nodeId: NodeId
): RuntimeActionExecutor {
  return (action, input) => Effect.runPromise(runAction(nodeId, action, input));
}
