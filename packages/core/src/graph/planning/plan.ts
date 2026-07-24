import { Effect } from "effect";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import type { GraphNodeCell, GraphNodeState, GraphPlanState } from "../cell/cellModel";
import {
  type CellBase,
  idleCell,
  invalidCell,
  phaseReadyData,
  projectCellPhase,
} from "../cell/cellPhase";
import { makeGraphCellState } from "../cell/cellState";
import { markInvalidState } from "../cell/cellTransitions";
import { teardownReadyData } from "../lifecycle/cleanup";
import { toNodeRead, unwiredNodeRead } from "../projection";
import { normalizeResultValidityPolicy, staticResultValidityPolicy } from "../resultValidity";
import {
  CycleDetected,
  DuplicateNodeTag,
  type NodeId,
  type NodeKey,
  type NodeRead,
  type NodeRequest,
  type NormalizedResultValidityPolicy,
} from "../types";
import {
  checkReplannedDependencies,
  planDependencyRequests,
  sameDependencyIds,
} from "./dependencyDefinitions";
import type { NodeDescriptor } from "./descriptor";
import {
  type KeyResolutionFailure,
  type ResolvedNodeIdentity,
  resolveNodeIdentity,
} from "./identity";
import { type GraphOutcome, graphFailure, graphSuccess } from "./outcome";

const EDGE_KEY_SEPARATOR = "\u0000";

export function ensurePlannedNode(
  state: GraphPlanState,
  request: NodeRequest
): Effect.Effect<NodeRead> {
  return planNode(state, request, []);
}

function materializeCellIfFresh(
  state: GraphPlanState,
  identity: ResolvedNodeIdentity,
  originalRequest: NodeRequest
): void {
  const { request, descriptor, key, nodeId, keyResult, duplicateTag } = identity;
  const resultValidityPolicyResult = resultValidityPolicyForDescriptor(descriptor, {
    nodeId,
    tag: descriptor.tag,
  });
  const planningOutcome = initialPlanningOutcome({
    keyResult,
    duplicateTag,
    nodeId,
    tag: descriptor.tag,
    args: request.args,
    resultValidityPolicyResult,
  });
  const initialBase =
    planningOutcome._tag === "Success"
      ? planningOutcome.value.base
      : baseForInvalidPlan(request.args);
  // Seed the revision past any evicted predecessor for this node id so
  // `readVersion` stays monotonic across evict + recreate instead of ABA-ing.
  const evictedRevision = state.evictedRevisionByNodeId.get(nodeId);
  const nodeState = makeGraphCellState(
    {
      phase:
        planningOutcome._tag === "Success"
          ? idleCell(planningOutcome.value.base)
          : invalidCell(planningOutcome.failure, initialBase),
      nextOperationId: 1,
      nextAttemptId: 0,
      nextLiveGeneration: 1,
    } satisfies GraphNodeState,
    evictedRevision === undefined ? 0 : evictedRevision + 1
  );

  // Owner: planning owns graph identity and dependency records before readiness.
  // Ready author nodes are constructed later by acquire, never during planning.
  if (!duplicateTag) {
    state.specByTag.set(descriptor.tag, request.spec);
  }
  state.nodes.set(nodeId, {
    nodeId,
    tag: descriptor.tag,
    kind: descriptor.kind,
    key,
    label: `${descriptor.kind}:${descriptor.tag}`,
    request,
    originalRequest,
    descriptor,
    resultValidityPolicy:
      resultValidityPolicyResult._tag === "Success"
        ? resultValidityPolicyResult.value
        : staticResultValidityPolicy,
    dependencies: {},
    state: nodeState,
    notifyChanged: state.notifyNodeChanged,
    notifyOperationStarted: state.notifyOperationStarted,
    notifyActionCompleted: state.notifyActionCompleted,
    notifyResultValidityChanged: state.notifyResultValidityChanged,
  });
}

function planNode(
  state: GraphPlanState,
  originalRequest: NodeRequest,
  visiting: ReadonlyArray<NodeId>
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const identity = resolveNodeIdentity(state, originalRequest);
    const { descriptor, nodeId, keyResult, duplicateTag, request } = identity;
    const existing = lookupGraphNodeCell(state, nodeId);

    // Contract: re-planning a known identity with an invalid key/tag must mark
    // the existing cell invalid and stop before dependency wiring mutates edges.
    if (existing._tag === "Found" && (keyResult._tag === "Failure" || duplicateTag)) {
      const failure =
        keyResult._tag === "Failure"
          ? keyResult.failure.failure
          : new DuplicateNodeTag({
              nodeId,
              tag: descriptor.tag,
            });
      yield* markCellInvalid(state, existing.cell, failure);
      return yield* toNodeRead(existing.cell);
    }

    if (existing._tag === "Missing") {
      materializeCellIfFresh(state, identity, originalRequest);
    }

    const currentCell = lookupGraphNodeCell(state, nodeId);

    if (currentCell._tag === "Missing") {
      return unwiredNodeRead(nodeId);
    }

    const currentState = yield* currentCell.cell.state.get;
    const currentProjection = projectCellPhase(currentState.phase);

    if (currentProjection._tag !== "Removed" && currentProjection.status._tag === "Invalid") {
      return yield* toNodeRead(currentCell.cell);
    }

    if (visiting.includes(nodeId)) {
      // Hazard: cycles are graph wiring failures, not driver failures. Mark the
      // whole cycle invalid so no member later tries to acquire from partial deps.
      const path = [...visiting.slice(visiting.indexOf(nodeId)), nodeId];
      yield* markCycleInvalid(state, path);
      return yield* toNodeRead(currentCell.cell);
    }

    // Contract: an existing identity keeps its original args, so a re-plan whose
    // request projects to the same key must also produce the same static
    // dependency ids. Mixing old args with new edges would corrupt the cell;
    // mirror the argsOperation same-identity invariant and invalidate instead.
    if (existing._tag === "Found") {
      const dependencyCheck = checkReplannedDependencies(state, currentCell.cell, request);

      if (dependencyCheck._tag === "Mismatch") {
        yield* markCellInvalid(state, currentCell.cell, dependencyCheck.failure);
        return yield* toNodeRead(currentCell.cell);
      }
    }

    return yield* wirePlannedDependencies(state, currentCell.cell, descriptor, request, nodeId, [
      ...visiting,
      nodeId,
    ]);
  });
}

function wirePlannedDependencies(
  state: GraphPlanState,
  currentCell: GraphNodeCell,
  descriptor: NodeDescriptor,
  request: NodeRequest,
  nodeId: NodeId,
  visiting: ReadonlyArray<NodeId>
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const plannedDependencies = yield* planDependencies({
      state,
      descriptor,
      request,
      nodeId,
      visiting,
    });

    if (plannedDependencies._tag === "Failure") {
      yield* markCellInvalid(state, currentCell, plannedDependencies.failure);
      return yield* toNodeRead(currentCell);
    }

    recordCellDependencies(state, nodeId, plannedDependencies.value);

    const plannedCell = lookupGraphNodeCell(state, nodeId);

    return plannedCell._tag === "Missing"
      ? unwiredNodeRead(nodeId)
      : yield* toNodeRead(plannedCell.cell);
  });
}

function planDependencies(input: {
  readonly state: GraphPlanState;
  readonly descriptor: NodeDescriptor;
  readonly request: NodeRequest;
  readonly nodeId: NodeId;
  readonly visiting: ReadonlyArray<NodeId>;
}) {
  return Effect.gen(function* () {
    const dependencyRequests = planDependencyRequests(input);

    if (dependencyRequests._tag === "Failure") {
      return graphFailure(dependencyRequests.failure);
    }

    // Contract: sibling dependencies are all planned after shape validation so
    // malformed dependency entries can be aggregated before parent invalidation.
    const dependencyIds: Record<string, NodeId> = {};

    for (const dependencyRequest of dependencyRequests.value) {
      const dependencyHandle = yield* planNode(
        input.state,
        dependencyRequest.request,
        input.visiting
      );
      dependencyIds[dependencyRequest.name] = dependencyHandle.nodeId;
      recordDependencyEdge(input.state, input.nodeId, dependencyRequest.name, dependencyHandle);
    }

    return graphSuccess(dependencyIds);
  });
}

function recordDependencyEdge(
  state: GraphPlanState,
  from: NodeId,
  dependency: string,
  dependencyHandle: NodeRead
): void {
  // Keyed by (from, dependency name): one dependency slot owns exactly one edge,
  // so a legitimate rewire replaces the previous edge instead of accumulating a
  // stale sibling that would feed reverse adjacency during eviction.
  const edgeKey = makeEdgeKey(from, dependency);
  const existing = state.edges.get(edgeKey);

  if (existing !== undefined && existing.to === dependencyHandle.nodeId) {
    return;
  }

  state.edges.set(edgeKey, {
    from,
    to: dependencyHandle.nodeId,
    dependency,
  });
}

function recordCellDependencies(
  state: GraphPlanState,
  nodeId: NodeId,
  dependencyIds: Record<string, NodeId>
): void {
  const latestCell = lookupGraphNodeCell(state, nodeId);

  if (latestCell._tag !== "Found") {
    return;
  }

  // Stable re-plans dominate this path; rewriting the cell with a fresh shallow
  // clone for an equal dependency record produced gratuitous allocation and
  // forced downstream observers to walk the unchanged set.
  if (sameDependencyIds(latestCell.cell.dependencies, dependencyIds)) {
    return;
  }

  state.nodes.set(nodeId, { ...latestCell.cell, dependencies: dependencyIds });
}

function resultValidityPolicyForDescriptor(
  descriptor: NodeDescriptor,
  context: {
    readonly nodeId: NodeId;
    readonly tag: string;
  }
): GraphOutcome<NormalizedResultValidityPolicy, unknown> {
  try {
    return graphSuccess(normalizeResultValidityPolicy(descriptor.driver.resultValidity, context));
  } catch (failure) {
    return graphFailure(failure);
  }
}

function initialPlanningOutcome(input: {
  readonly keyResult: GraphOutcome<NodeKey, KeyResolutionFailure>;
  readonly duplicateTag: boolean;
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly args: unknown;
  readonly resultValidityPolicyResult: GraphOutcome<NormalizedResultValidityPolicy, unknown>;
}): GraphOutcome<{ readonly base: CellBase }, unknown> {
  if (input.keyResult._tag === "Failure") {
    return graphFailure(input.keyResult.failure.failure);
  }

  if (input.duplicateTag) {
    return graphFailure(
      new DuplicateNodeTag({
        nodeId: input.nodeId,
        tag: input.tag,
      })
    );
  }

  if (input.resultValidityPolicyResult._tag === "Failure") {
    return graphFailure(input.resultValidityPolicyResult.failure);
  }

  return graphSuccess({
    base: {
      args: input.args,
      liveLeases: [],
    },
  });
}

function baseForInvalidPlan(args: unknown): CellBase {
  return {
    args,
    liveLeases: [],
  };
}

function makeEdgeKey(from: NodeId, dependency: string): string {
  return [from, dependency].join(EDGE_KEY_SEPARATOR);
}

function markCycleInvalid(state: GraphPlanState, path: ReadonlyArray<NodeId>): Effect.Effect<void> {
  return Effect.forEach(
    [...new Set(path)],
    (cycleNodeId) =>
      Effect.gen(function* () {
        const cell = lookupGraphNodeCell(state, cycleNodeId);

        if (cell._tag === "Missing") {
          return;
        }

        const failure = new CycleDetected({
          nodeId: cell.cell.nodeId,
          tag: cell.cell.tag,
          path,
        });

        yield* markCellInvalid(state, cell.cell, failure);
      }),
    { concurrency: 1, discard: true }
  );
}

function markCellInvalid(
  state: GraphPlanState,
  cell: GraphNodeCell,
  failure: unknown
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const actor =
      state.cellActors === undefined
        ? undefined
        : yield* state.cellActors.getExistingActor(cell.nodeId);

    if (actor !== undefined) {
      yield* actor.close({
        _tag: "Released",
        detail: "graph cell invalidated",
      });
      const deleteActor = state.cellActors?.deleteActor(cell.nodeId, actor) ?? Effect.void;
      const ready = yield* actor.runExclusive(markInvalidCellState(cell, failure));
      yield* actor
        .runExclusiveFork(
          teardownInvalidatedReadyData(state, cell, ready).pipe(Effect.ensuring(deleteActor))
        )
        .pipe(Effect.asVoid);
      return;
    }

    const ready = yield* markInvalidCellState(cell, failure);
    yield* teardownInvalidatedReadyData(state, cell, ready);
  });
}

function markInvalidCellState(
  cell: GraphNodeCell,
  failure: unknown
): Effect.Effect<ReturnType<typeof phaseReadyData>> {
  return Effect.gen(function* () {
    let ready = phaseReadyData((yield* cell.state.get).phase);
    yield* cell.state.transition((latest) => {
      ready = phaseReadyData(latest.phase);
      return [undefined, markInvalidState({ latest, failure })];
    });
    return ready;
  });
}

function teardownInvalidatedReadyData(
  state: GraphPlanState,
  cell: GraphNodeCell,
  ready: ReturnType<typeof phaseReadyData>
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // Contract: invalidating a ready cell commits Invalid first, but it still
    // owns teardown of the captured ready generation.
    if (ready._tag === "Found") {
      const cleanupFailures = yield* teardownReadyData(
        cell,
        ready.ready,
        { release: state.driverTimeouts.release, live: state.driverTimeouts.live },
        { _tag: "ReadyInvalidated" }
      );

      if (cleanupFailures.length > 0) {
        yield* state.notifyCleanupFailures(cell.nodeId, "invalidate", cleanupFailures);
      }
    }
  });
}
