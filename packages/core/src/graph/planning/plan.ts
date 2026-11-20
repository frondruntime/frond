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
import { projectNodeRead, unwiredNodeRead } from "../projection";
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
  confirmWiredDependencies,
  planDependencyRequests,
  sameDependencyIds,
} from "./dependencyDefinitions";
import type { NodeDescriptor } from "./descriptor";
import { developmentChecks } from "./developmentChecks";
import {
  type KeyResolutionFailure,
  type ResolvedNodeIdentity,
  resolveNodeIdentity,
} from "./identity";
import { type GraphOutcome, graphFailure, graphSuccess } from "./outcome";

const EDGE_KEY_SEPARATOR = "\u0000";

export function ensurePlannedNodeSync(state: GraphPlanState, request: NodeRequest): NodeRead {
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
  // Consume the entry: the recreated cell starts past the recorded value and a
  // later eviction re-records it, so keeping it would only leak one map entry
  // per distinct evicted node id.
  const evictedRevision = state.evictedRevisionByNodeId.get(nodeId);
  if (evictedRevision !== undefined) {
    state.evictedRevisionByNodeId.delete(nodeId);
  }
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
    jobs: state.jobs,
    syncClock: state.syncClock,
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
    notifyReadinessFailed: state.notifyReadinessFailed,
    wiredGeneration: 0,
  });
}

function planNode(
  state: GraphPlanState,
  originalRequest: NodeRequest,
  visiting: ReadonlyArray<NodeId>
): NodeRead {
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
    markCellInvalid(state, existing.cell, failure);
    return projectNodeRead(existing.cell, existing.cell.state.getSync());
  }

  if (existing._tag === "Missing") {
    materializeCellIfFresh(state, identity, originalRequest);
  }

  const currentCell = lookupGraphNodeCell(state, nodeId);

  if (currentCell._tag === "Missing") {
    return unwiredNodeRead(nodeId);
  }

  const currentState = currentCell.cell.state.getSync();
  const currentProjection = projectCellPhase(currentState.phase);

  if (currentProjection._tag !== "Removed" && currentProjection.status._tag === "Invalid") {
    return projectNodeRead(currentCell.cell, currentCell.cell.state.getSync());
  }

  if (visiting.includes(nodeId)) {
    // Hazard: cycles are graph wiring failures, not driver failures. Mark the
    // whole cycle invalid so no member later tries to acquire from partial deps.
    const path = [...visiting.slice(visiting.indexOf(nodeId)), nodeId];
    markCycleInvalid(state, path);
    return projectNodeRead(currentCell.cell, currentCell.cell.state.getSync());
  }

  // Contract: `dependencies(args)` is a pure function of args, so a cell
  // stamped at the current generation already holds the cell and edge of every
  // dependency in its closure, none of them Invalid, and a same-key re-plan
  // returns it without re-planning. Development builds still validate and
  // confirm the requested node's own dependencies (not its internal ones); any
  // other result takes the full re-plan below, unchanged.
  if (
    existing._tag === "Found" &&
    currentProjection._tag !== "Removed" &&
    currentCell.cell.wiredGeneration === state.wiringGeneration &&
    (!developmentChecks.replanDependencies ||
      confirmWiredDependencies(state, currentCell.cell, descriptor, request))
  ) {
    return projectNodeRead(currentCell.cell, currentState);
  }

  // Contract: an existing identity keeps its original args, so a re-plan whose
  // request projects to the same key must also produce the same static
  // dependency ids. Mixing old args with new edges would corrupt the cell;
  // mirror the argsOperation same-identity invariant and invalidate instead.
  if (existing._tag === "Found") {
    const dependencyCheck = checkReplannedDependencies(state, currentCell.cell, request);

    if (dependencyCheck._tag === "Mismatch") {
      markCellInvalid(state, currentCell.cell, dependencyCheck.failure);
      return projectNodeRead(currentCell.cell, currentCell.cell.state.getSync());
    }
  }

  return wirePlannedDependencies(state, currentCell.cell, descriptor, request, nodeId, [
    ...visiting,
    nodeId,
  ]);
}

function wirePlannedDependencies(
  state: GraphPlanState,
  currentCell: GraphNodeCell,
  descriptor: NodeDescriptor,
  request: NodeRequest,
  nodeId: NodeId,
  visiting: ReadonlyArray<NodeId>
): NodeRead {
  const plannedDependencies = planDependencies({
    state,
    descriptor,
    request,
    nodeId,
    visiting,
  });

  if (plannedDependencies._tag === "Failure") {
    markCellInvalid(state, currentCell, plannedDependencies.failure);
    return projectNodeRead(currentCell, currentCell.state.getSync());
  }

  recordCellDependencies(state, nodeId, plannedDependencies.value);

  const plannedCell = lookupGraphNodeCell(state, nodeId);

  if (plannedCell._tag === "Missing") {
    return unwiredNodeRead(nodeId);
  }

  if (closureIsWired(state, plannedCell.cell)) {
    plannedCell.cell.wiredGeneration = state.wiringGeneration;
  }
  return projectNodeRead(plannedCell.cell, plannedCell.cell.state.getSync());
}

// Contract: a stamp vouches for the cell's whole closure, so stamp only a cell
// that is not Invalid after wiring and whose direct dependencies all carry the
// current stamp; each of those vouches for its own closure in turn. Entering
// Invalid and releasing out of it both bump the generation (`markCellInvalid`,
// `releaseCell`), so no stamp outlives a closure member's Invalid phase.
function closureIsWired(state: GraphPlanState, cell: GraphNodeCell): boolean {
  if (cell.state.getSync().phase._tag === "Invalid") {
    return false;
  }

  for (const dependencyName in cell.dependencies) {
    const dependencyId = cell.dependencies[dependencyName];
    const dependency = dependencyId === undefined ? undefined : state.nodes.get(dependencyId);

    if (dependency === undefined || dependency.wiredGeneration !== state.wiringGeneration) {
      return false;
    }
  }

  return true;
}

function planDependencies(input: {
  readonly state: GraphPlanState;
  readonly descriptor: NodeDescriptor;
  readonly request: NodeRequest;
  readonly nodeId: NodeId;
  readonly visiting: ReadonlyArray<NodeId>;
}) {
  const dependencyRequests = planDependencyRequests(input);

  if (dependencyRequests._tag === "Failure") {
    return graphFailure(dependencyRequests.failure);
  }

  // Contract: sibling dependencies are all planned after shape validation so
  // malformed dependency entries can be aggregated before parent invalidation.
  const dependencyIds: Record<string, NodeId> = {};

  for (const dependencyRequest of dependencyRequests.value) {
    const dependencyHandle = planNode(input.state, dependencyRequest.request, input.visiting);
    dependencyIds[dependencyRequest.name] = dependencyHandle.nodeId;
    recordDependencyEdge(input.state, input.nodeId, dependencyRequest.name, dependencyHandle);
  }

  return graphSuccess(dependencyIds);
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

function markCycleInvalid(state: GraphPlanState, path: ReadonlyArray<NodeId>): void {
  for (const nodeId of new Set(path)) {
    const cell = state.nodes.get(nodeId);
    if (cell !== undefined)
      markCellInvalid(state, cell, new CycleDetected({ nodeId, tag: cell.tag, path }));
  }
}

function markCellInvalid(state: GraphPlanState, cell: GraphNodeCell, failure: unknown): void {
  const phase = cell.state.getSync().phase;
  const ready = phaseReadyData(phase);
  cell.state.updateSync((latest) => {
    markInvalidState({ latest, failure });
  });
  // Entering Invalid makes every stamp whose closure holds this cell stale; see
  // `closureIsWired`. A cell already Invalid is in no stamped closure, and
  // re-planning one (a key that keeps failing) must not cost the whole graph
  // its fast path.
  if (phase._tag !== "Invalid") {
    state.wiringGeneration += 1;
  }
  if (phase._tag === "Acquiring")
    phase.attempt.resolve(projectNodeRead(cell, cell.state.getSync()));
  // Invalid is visible immediately. Cancellation and release stay queued and
  // retain ownership of the captured ready generation until teardown finishes.
  if (ready._tag === "Missing" && phase._tag !== "Acquiring") return;
  state.enqueue(
    Effect.gen(function* () {
      const queue = state.cellQueues.getExistingQueue(cell.nodeId);
      const cleanup = teardownInvalidatedReadyData(state, cell, ready);
      if (queue === undefined) {
        yield* cleanup;
        return;
      }
      yield* queue.shutdown({
        reason: { _tag: "Released", detail: "graph cell invalidated" },
        cleanup,
      });
      state.cellQueues.deleteQueue(cell.nodeId, queue);
    })
  );
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
