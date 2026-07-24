import { Effect } from "effect";
import type { RuntimeActionEffectExecutor, RuntimeActionExecutor } from "../../node/runtime";
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

/**
 * Exposes graph-native action execution as an Effect to Effect-native node
 * callers, without collapsing through `runPromise`.
 *
 * Boundary: this keeps the action Effect-native end to end so the effect action
 * channel composes with the caller's fiber. The returned Effect resolves to the
 * `ActionResult` tagged union; the node facade maps Success/Failure onto the
 * value/error channels.
 */
export function bridgeNodeActionEffectRunner(
  runAction: NodeActionRunner,
  nodeId: NodeId
): RuntimeActionEffectExecutor {
  return (action, input) => runAction(nodeId, action, input);
}
