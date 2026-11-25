import type { GraphNodeCellView, GraphNodeState } from "../cell/cellModel";
import {
  type CellPhaseProjection,
  phaseReadyData,
  projectCellPhase,
  projectLiveDemand,
} from "../cell/cellPhase";
import { idleOperation } from "../operations/nodeOperation";
import { effectiveResultValidity } from "../resultValidity";
import type { NodeId, NodeRead, NodeSnapshot, ProjectionContext } from "../types";

export function projectNodeSnapshot(
  cell: GraphNodeCellView,
  state: GraphNodeState,
  context: ProjectionContext
): NodeSnapshot {
  const projection = projectCellPhase(state.phase);

  switch (projection._tag) {
    case "Idle":
    case "Pending":
    case "ReadinessError":
    case "Ready":
    case "Invalid": {
      const projected = projection;
      return projectedNodeSnapshot(cell, projected, state, context.now);
    }
    case "Removed": {
      return {
        _tag: "Unwired",
        nodeId: cell.nodeId,
        status: { _tag: "Unwired" },
        tag: cell.tag,
        kind: cell.kind,
        key: cell.key,
        label: cell.label,
        liveDemand: projectLiveDemand([]),
        operation: idleOperation,
        revision: cell.state.getRevisionSync(),
      } satisfies NodeSnapshot;
    }
    default: {
      const unreachable: never = projection;
      return unreachable;
    }
  }
}

export function projectNodeRead(cell: GraphNodeCellView, state: GraphNodeState): NodeRead {
  const projection = projectCellPhase(state.phase);

  switch (projection._tag) {
    case "Removed": {
      return unwiredNodeRead(cell.nodeId);
    }
    case "Idle": {
      const projected = projection;
      return {
        _tag: "Idle",
        ...nodeReadFields(cell, projected),
      } satisfies NodeRead;
    }
    case "Pending": {
      const projected = projection;
      return {
        _tag: "Pending",
        ...nodeReadFields(cell, projected),
      } satisfies NodeRead;
    }
    case "Ready": {
      const projected = projection;
      return {
        _tag: "Ready",
        ...nodeReadFields(cell, projected),
        node: projected.node,
      } satisfies NodeRead;
    }
    case "ReadinessError": {
      const projected = projection;
      return {
        _tag: "Error",
        ...nodeReadFields(cell, projected),
        error: projectedFailureValue(projected.failure),
      } satisfies NodeRead;
    }
    case "Invalid": {
      const projected = projection;
      return {
        _tag: "Invalid",
        nodeId: cell.nodeId,
        tag: cell.tag,
        status: projected.status,
        nodeLookup: projected.nodeLookup,
        error: projectedFailureValue(projected.failure),
        resultValidity: projected.resultValidity,
      } satisfies NodeRead;
    }
    default: {
      const unreachable: never = projection;
      return unreachable;
    }
  }
}

function nodeReadFields(
  cell: GraphNodeCellView,
  projection: Exclude<CellPhaseProjection, { readonly _tag: "Invalid" | "Removed" }>
) {
  return {
    nodeId: cell.nodeId,
    tag: cell.tag,
    status: projection.status,
    resultValidity: projection.resultValidity,
  } as const;
}

export function unwiredNodeRead(nodeId: NodeId): NodeRead {
  return {
    _tag: "Unwired",
    nodeId,
    status: { _tag: "Unwired" },
  };
}

function projectedNodeSnapshot(
  cell: GraphNodeCellView,
  projection: Exclude<ReturnType<typeof projectCellPhase>, { readonly _tag: "Removed" }>,
  state: GraphNodeState,
  now: number
): NodeSnapshot {
  const ready = phaseReadyData(state.phase);
  const resultValidity =
    ready._tag === "Missing"
      ? projection.resultValidity
      : effectiveResultValidity(
          ready.ready.resultValidity,
          ready.ready.resultValidityPolicy,
          ready.ready.resultLoadedAt,
          now
        );
  const base = {
    nodeId: cell.nodeId,
    tag: cell.tag,
    kind: cell.kind,
    key: cell.key,
    label: cell.label,
    liveDemand: projection.liveDemand,
    liveFailure: projection.liveFailure,
    operation: projection.operation,
    operationFailure: projection.operationFailure,
    resultValidity,
    revision: cell.state.getRevisionSync(),
  };

  switch (projection._tag) {
    case "Ready": {
      const { result, status, node } = projection;
      return {
        ...base,
        _tag: "Ready",
        status,
        node,
        result,
      } satisfies NodeSnapshot;
    }
    case "Pending": {
      const { attempt, status } = projection;
      return {
        ...base,
        _tag: "Pending",
        status,
        attempt,
      } satisfies NodeSnapshot;
    }
    case "Idle": {
      const projected = projection;
      return snapshotWithProjectedFailure(
        {
          ...base,
          _tag: "Idle",
          status: projected.status,
        } satisfies NodeSnapshot,
        projected.failure
      );
    }
    case "ReadinessError": {
      const projected = projection;
      return snapshotWithProjectedFailure(
        {
          ...base,
          _tag: "ReadinessError",
          status: projected.status,
          error: projectedFailureValue(projected.failure),
        } satisfies NodeSnapshot,
        projected.failure
      );
    }
    case "Invalid": {
      const projected = projection;
      return snapshotWithProjectedFailure(
        {
          ...base,
          _tag: "Invalid",
          status: projected.status,
          nodeLookup: projected.nodeLookup,
          error: projectedFailureValue(projected.failure),
        } satisfies NodeSnapshot,
        projected.failure
      );
    }
    default: {
      const unreachable: never = projection;
      return unreachable;
    }
  }
}

function projectedFailureValue(
  failure: Exclude<ReturnType<typeof projectCellPhase>, { readonly _tag: "Removed" }>["failure"]
): unknown {
  return failure._tag === "Present" ? failure.failure : undefined;
}

function snapshotWithProjectedFailure(
  base: NodeSnapshot,
  failure: Exclude<ReturnType<typeof projectCellPhase>, { readonly _tag: "Removed" }>["failure"]
): NodeSnapshot {
  return failure._tag === "Present" ? { ...base, failure: failure.failure } : base;
}
