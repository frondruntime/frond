import type { NodeId } from "../graph";
import type { RuntimeClientCore } from "./clientCore";
import { type RuntimeReadHost, readRawNode } from "./nodeRead";
import type { RawRuntimeNodeRead, RuntimeClient, UnsafeScheduleResult } from "./types";

type UnsafeClientCore = Pick<RuntimeClientCore, "scheduleUnsafe">;

/**
 * Creates the devtools/test escape hatch client.
 *
 * Boundary: unsafe calls are fire-and-forget scheduling helpers over current
 * projection state. Product code should use typed node handles instead.
 */
export function createUnsafeRuntimeClient(
  runtime: RuntimeReadHost,
  core: UnsafeClientCore
): RuntimeClient["__unsafe"] {
  const readNodeUnsafe = (nodeId: NodeId): RawRuntimeNodeRead<unknown> =>
    readRawNode<unknown>(runtime, nodeId);

  const ensureReady = (nodeId: NodeId): UnsafeScheduleResult => {
    const read = readNodeUnsafe(nodeId);

    if (read._tag === "Unwired") {
      return { _tag: "Unwired", nodeId };
    }

    if (read._tag === "Invalid" || read._tag === "Unavailable") {
      return { _tag: "Invalid", nodeId, error: read.error };
    }

    core.scheduleUnsafe({
      _tag: "GraphEnsureReadyNodeById",
      nodeId,
    });
    return { _tag: "Scheduled", nodeId };
  };

  const refresh = (nodeId: NodeId): UnsafeScheduleResult => {
    const read = readNodeUnsafe(nodeId);

    if (read._tag === "Unwired") {
      return { _tag: "Unwired", nodeId };
    }

    if (read._tag === "Invalid" || read._tag === "Unavailable") {
      return { _tag: "Invalid", nodeId, error: read.error };
    }

    core.scheduleUnsafe({
      _tag: "GraphRefreshNode",
      request: {
        target: {
          _tag: "NodeId",
          nodeId,
        },
      },
    });
    return { _tag: "Scheduled", nodeId };
  };

  const updateNode = (
    nodeId: NodeId,
    recipe: (node: object) => void,
    options?: { readonly label?: string | undefined } | undefined
  ): UnsafeScheduleResult => {
    const read = readNodeUnsafe(nodeId);

    if (read._tag === "Unwired") {
      return { _tag: "Unwired", nodeId };
    }

    if (read._tag === "Invalid" || read._tag === "Unavailable") {
      return { _tag: "Invalid", nodeId, error: read.error };
    }

    // Devtools escape hatch: unsafe updates intentionally bypass request/args
    // validation and operate on an existing node id plus a mutation recipe.
    core.scheduleUnsafe({
      _tag: "GraphUnsafeUpdateNode",
      request: {
        nodeId,
        recipe,
        label: options?.label,
      },
    });
    return { _tag: "Scheduled", nodeId };
  };

  return {
    readNode: readNodeUnsafe,
    ensureReady,
    refresh,
    updateNode,
  };
}
