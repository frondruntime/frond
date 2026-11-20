import type { Effect } from "effect";
import type { RuntimeActionEffectExecutor, RuntimeActionExecutor } from "../../node/runtime";
import { corePromise } from "../../runtime/promiseFacade";
import type { CoreCall } from "../queue/reply";
import type { ActionResult, NodeId } from "../types";

export type NodeActionRunner = (
  nodeId: NodeId,
  action: string,
  input: unknown
) => Effect.Effect<ActionResult>;

/** One Promise over the same callback submission used by the Effect facade. */
export function bridgeNodeActionRunner(
  runAction: CoreCall<NodeActionRunner>,
  nodeId: NodeId
): RuntimeActionExecutor {
  return (action, input) =>
    corePromise((resume) => runAction(nodeId, action, input, undefined, resume), actionValue);
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

function actionValue(result: ActionResult): unknown {
  switch (result._tag) {
    case "Success":
      return result.value;
    case "Failure":
      throw result.error;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
