import { Clock, Effect, Match } from "effect";
import { phaseReadyData, projectCellPhase, projectLiveDemand } from "../cell/cellPhase";
import { idleOperation } from "../operations/nodeOperation";
import type { GraphNodeCellView, GraphNodeState } from "../planning/plan";
import { effectiveResultValidity } from "../resultValidity";
import type { NodeSnapshot, ProjectionContext } from "../types";

export function toSnapshot(
  cell: GraphNodeCellView,
  context?: ProjectionContext | undefined
): Effect.Effect<NodeSnapshot> {
  return Effect.gen(function* () {
    const state = yield* cell.state.get;
    const projectionContext =
      context === undefined ? { now: yield* Clock.currentTimeMillis } : context;
    return projectNodeSnapshot(cell, state, projectionContext);
  });
}

export function projectNodeSnapshot(
  cell: GraphNodeCellView,
  state: GraphNodeState,
  context: ProjectionContext
): NodeSnapshot {
  const projection = projectCellPhase(state.phase);

  return Match.value(projection).pipe(
    Match.tag("Idle", (projected) => projectedNodeSnapshot(cell, projected, state, context.now)),
    Match.tag("Pending", (projected) => projectedNodeSnapshot(cell, projected, state, context.now)),
    Match.tag("ReadinessError", (projected) =>
      projectedNodeSnapshot(cell, projected, state, context.now)
    ),
    Match.tag("Ready", (projected) => projectedNodeSnapshot(cell, projected, state, context.now)),
    Match.tag("Releasing", (projected) =>
      projectedNodeSnapshot(cell, projected, state, context.now)
    ),
    Match.tag("Invalid", (projected) => projectedNodeSnapshot(cell, projected, state, context.now)),
    Match.tag(
      "Removed",
      () =>
        ({
          _tag: "Unwired",
          nodeId: cell.nodeId,
          status: { _tag: "Unwired" },
          tag: cell.tag,
          kind: cell.kind,
          key: cell.key,
          label: cell.label,
          liveDemand: projectLiveDemand([]),
          operation: idleOperation,
        }) satisfies NodeSnapshot
    ),
    Match.exhaustive
  );
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
  };

  return Match.value(projection).pipe(
    Match.tag(
      "Ready",
      ({ result, status, node }) =>
        ({
          ...base,
          _tag: "Ready",
          status,
          node,
          result,
        }) satisfies NodeSnapshot
    ),
    Match.tag(
      "Pending",
      ({ attempt, status }) =>
        ({
          ...base,
          _tag: "Pending",
          status,
          attempt,
        }) satisfies NodeSnapshot
    ),
    Match.tag("Idle", (projected) =>
      snapshotWithProjectedFailure(
        {
          ...base,
          _tag: "Idle",
          status: projected.status,
        } satisfies NodeSnapshot,
        projected.failure
      )
    ),
    Match.tag("ReadinessError", (projected) =>
      snapshotWithProjectedFailure(
        {
          ...base,
          _tag: "ReadinessError",
          status: projected.status,
          error: projectedFailureValue(projected.failure),
        } satisfies NodeSnapshot,
        projected.failure
      )
    ),
    Match.tag("Invalid", (projected) =>
      snapshotWithProjectedFailure(
        {
          ...base,
          _tag: "Invalid",
          status: projected.status,
          nodeLookup: projected.nodeLookup,
          error: projectedFailureValue(projected.failure),
        } satisfies NodeSnapshot,
        projected.failure
      )
    ),
    Match.tag("Releasing", (projected) =>
      snapshotWithProjectedFailure(
        {
          ...base,
          _tag: "Releasing",
          status: projected.status,
        } satisfies NodeSnapshot,
        projected.failure
      )
    ),
    Match.exhaustive
  );
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
