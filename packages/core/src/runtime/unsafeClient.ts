import type { NodeId } from "../graph";
import type { RuntimeEffectBridgeRunner } from "./client";
import { type RuntimeReadHost, readRawNode } from "./nodeRead";
import type {
  RawRuntimeNodeRead,
  RuntimeClient,
  RuntimeCommand,
  RuntimeHostService,
  UnsafeScheduleResult,
} from "./types";

type UnsafeRuntimeHost = Pick<RuntimeHostService, "submit"> &
  RuntimeReadHost & {
    readonly recordUnsafeScheduleFailure?:
      | ((command: RuntimeCommand, cause: unknown) => void)
      | undefined;
  };

/**
 * Creates the devtools/test escape hatch client.
 *
 * Boundary: unsafe calls are fire-and-forget scheduling helpers over current
 * projection state. Product code should use typed node handles instead.
 */
export function createUnsafeRuntimeClient(
  runtime: UnsafeRuntimeHost,
  runner: RuntimeEffectBridgeRunner
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

    scheduleUnsafe(runtime, runner, {
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

    scheduleUnsafe(runtime, runner, {
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
    scheduleUnsafe(runtime, runner, {
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

function scheduleUnsafe(
  runtime: Pick<RuntimeHostService, "submit"> & {
    readonly recordUnsafeScheduleFailure?:
      | ((command: RuntimeCommand, cause: unknown) => void)
      | undefined;
  },
  runner: RuntimeEffectBridgeRunner,
  command: RuntimeCommand
): void {
  // Fire-and-forget: run the Effect submit through the bridge and never await.
  // Failures are surfaced to the diagnostics hook instead of being swallowed.
  void runner.run(runtime.submit(command)).catch((cause) => {
    runtime.recordUnsafeScheduleFailure?.(command, cause);
  });
}
