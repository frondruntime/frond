import { Effect, Match } from "effect";
import type { Dependency } from "../../node";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import {
  type CellBase,
  type CellPhase,
  type CellPhaseProjection,
  idleCell,
  invalidCell,
  phaseReadyData,
  projectCellPhase,
} from "../cell/cellPhase";
import {
  type GraphCellState,
  type GraphCellStateReader,
  makeGraphCellState,
} from "../cell/cellState";
import { markInvalidState } from "../cell/cellTransitions";
import { teardownReadyData } from "../lifecycle/cleanup";
import { normalizeResultValidityPolicy, staticResultValidityPolicy } from "../resultValidity";
import {
  type ActionResult,
  CycleDetected,
  DependencyDefinitionFailed,
  DependencyDefinitionFailures,
  type DriverOperationTimeouts,
  DuplicateNodeTag,
  type EdgeSnapshot,
  type GraphActionCompletionObserver,
  type GraphCleanupFailureObserver,
  GraphInvariantViolation,
  type GraphLiveFailureObserver,
  type GraphNodeChangeObserver,
  type GraphOperationStartObserver,
  type GraphResultValidityObserver,
  KeyBuildFailed,
  type NodeId,
  type NodeKey,
  type NodeLiveDemandSnapshot,
  type NodeLiveLeaseId,
  type NodeRead,
  type NodeRequest,
  type NodeSnapshot,
  type NormalizedResultValidityPolicy,
  type ObservedResultLease,
} from "../types";
import { canonicalKey } from "./canonicalKey";
import { getNodeDescriptor, isFrondNodeSpec, type NodeDescriptor } from "./descriptor";
import { makeNodeId } from "./identity";
import { type GraphOutcome, graphFailure, graphSuccess } from "./outcome";
import { applySpecOverride } from "./specOverrides";

const EDGE_KEY_SEPARATOR = "\u0000";

export interface GraphPlanState {
  readonly nodes: Map<NodeId, GraphNodeCell>;
  readonly edges: Map<string, EdgeSnapshot>;
  readonly specByTag: Map<string, unknown>;
  readonly specOverrides: ReadonlyMap<unknown, unknown>;
  readonly driverTimeouts: DriverOperationTimeouts;
  readonly nextLiveLeaseId: () => NodeLiveLeaseId;
  readonly executeNodeAction: (
    nodeId: NodeId,
    action: string,
    input: unknown
  ) => Effect.Effect<ActionResult>;
  readonly notifyNodeChanged: GraphNodeChangeObserver;
  readonly notifyOperationStarted: GraphOperationStartObserver;
  readonly notifyActionCompleted: GraphActionCompletionObserver;
  readonly notifyResultValidityChanged: GraphResultValidityObserver;
  readonly notifyLiveDemandChanged: (
    nodeId: NodeId,
    liveDemand: NodeLiveDemandSnapshot
  ) => Effect.Effect<void>;
  readonly notifyLiveFailures: GraphLiveFailureObserver;
  readonly notifyCleanupFailures: GraphCleanupFailureObserver;
  readonly reportResultObserved: (
    nodeId: NodeId,
    scope: unknown,
    observed: boolean,
    lease: ObservedResultLease
  ) => Promise<ObservedResultLease>;
}

export interface GraphNodeCellView {
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly kind: string;
  readonly key: NodeSnapshot["key"];
  readonly label: string;
  readonly descriptor: NodeDescriptor;
  readonly resultValidityPolicy: NormalizedResultValidityPolicy;
  readonly dependencies: Readonly<Record<string, NodeId>>;
  readonly state: GraphCellStateReader<GraphNodeState>;
}

export interface GraphNodeCell extends GraphNodeCellView {
  readonly request: NodeRequest;
  readonly originalRequest: NodeRequest;
  readonly state: GraphCellState<GraphNodeState>;
  readonly notifyChanged: GraphNodeChangeObserver;
  readonly notifyOperationStarted: GraphOperationStartObserver;
  readonly notifyActionCompleted: GraphActionCompletionObserver;
  readonly notifyResultValidityChanged: GraphResultValidityObserver;
}

export interface GraphNodeState {
  readonly nextOperationId: number;
  readonly nextAttemptId: number;
  readonly nextLiveGeneration: number;
  readonly phase: CellPhase;
}

export function ensurePlannedNode(
  state: GraphPlanState,
  request: NodeRequest
): Effect.Effect<NodeRead> {
  return planNode(state, request, []);
}

export function resolveNodeId(request: NodeRequest): NodeId {
  const descriptor = getNodeDescriptor(request.spec);
  const keyResult = resolveKey(descriptor, request);
  const key = keyResult._tag === "Success" ? keyResult.value : keyResult.failure.key;

  return makeNodeId(descriptor.tag, key);
}

export function resolveEffectiveNodeId(state: GraphPlanState, request: NodeRequest): NodeId {
  return resolveNodeId(applySpecOverride(state.specOverrides, request));
}

function handleOf(cell: GraphNodeCell): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const state = yield* cell.state.get;
    const projection = projectCellPhase(state.phase);

    return Match.value(projection).pipe(
      Match.tag("Removed", () => unwiredNodeRead(cell.nodeId)),
      Match.tag(
        "Idle",
        (projected) =>
          ({
            _tag: "Idle",
            ...nodeReadFields(cell, projected),
          }) satisfies NodeRead
      ),
      Match.tag(
        "Pending",
        (projected) =>
          ({
            _tag: "Pending",
            ...nodeReadFields(cell, projected),
          }) satisfies NodeRead
      ),
      Match.tag(
        "Ready",
        (projected) =>
          ({
            _tag: "Ready",
            ...nodeReadFields(cell, projected),
            node: projected.node,
          }) satisfies NodeRead
      ),
      Match.tag(
        "ReadinessError",
        (projected) =>
          ({
            _tag: "Error",
            ...nodeReadFields(cell, projected),
            error: projectedFailureValue(projected.failure),
          }) satisfies NodeRead
      ),
      Match.tag(
        "Releasing",
        (projected) =>
          ({
            _tag: "Idle",
            ...nodeReadFields(cell, projected),
          }) satisfies NodeRead
      ),
      Match.tag(
        "Invalid",
        (projected) =>
          ({
            _tag: "Invalid",
            nodeId: cell.nodeId,
            tag: cell.tag,
            status: projected.status,
            nodeLookup: projected.nodeLookup,
            error: projectedFailureValue(projected.failure),
            resultValidity: projected.resultValidity,
          }) satisfies NodeRead
      ),
      Match.exhaustive
    );
  });
}

function nodeReadFields(
  cell: GraphNodeCell,
  projection: Exclude<CellPhaseProjection, { readonly _tag: "Invalid" | "Removed" }>
) {
  return {
    nodeId: cell.nodeId,
    tag: cell.tag,
    status: projection.status,
    resultValidity: projection.resultValidity,
  } as const;
}

function unwiredNodeRead(nodeId: NodeId): NodeRead {
  return {
    _tag: "Unwired",
    nodeId,
    status: { _tag: "Unwired" },
  };
}

function projectedFailureValue(
  failure: Extract<ReturnType<typeof projectCellPhase>, { readonly _tag: "Invalid" }>["failure"]
): unknown {
  return failure._tag === "Present" ? failure.failure : undefined;
}

interface ResolvedNodeIdentity {
  readonly request: NodeRequest;
  readonly descriptor: NodeDescriptor;
  readonly key: NodeKey;
  readonly nodeId: NodeId;
  readonly keyResult: GraphOutcome<NodeKey, KeyResolutionFailure>;
  readonly duplicateTag: boolean;
}

function resolveNodeIdentity(
  state: GraphPlanState,
  originalRequest: NodeRequest
): ResolvedNodeIdentity {
  const request = applySpecOverride(state.specOverrides, originalRequest);
  const descriptor = getNodeDescriptor(request.spec);
  const keyResult = resolveKey(descriptor, request);
  const key = keyResult._tag === "Success" ? keyResult.value : keyResult.failure.key;
  const nodeId = makeNodeId(descriptor.tag, key);
  const duplicateTag = duplicateTagSpec(state, descriptor.tag, request.spec);

  return { request, descriptor, key, nodeId, keyResult, duplicateTag };
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
  const nodeState = makeGraphCellState({
    phase:
      planningOutcome._tag === "Success"
        ? idleCell(planningOutcome.value.base)
        : invalidCell(planningOutcome.failure, initialBase),
    nextOperationId: 1,
    nextAttemptId: 0,
    nextLiveGeneration: 1,
  } satisfies GraphNodeState);

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
      return yield* handleOf(existing.cell);
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
      return yield* handleOf(currentCell.cell);
    }

    if (visiting.includes(nodeId)) {
      // Hazard: cycles are graph wiring failures, not driver failures. Mark the
      // whole cycle invalid so no member later tries to acquire from partial deps.
      const path = [...visiting.slice(visiting.indexOf(nodeId)), nodeId];
      yield* markCycleInvalid(state, path);
      return yield* handleOf(currentCell.cell);
    }

    // Contract: an existing identity keeps its original args, so a re-plan whose
    // request projects to the same key must also produce the same static
    // dependency ids. Mixing old args with new edges would corrupt the cell;
    // mirror the argsOperation same-identity invariant and invalidate instead.
    if (existing._tag === "Found") {
      const dependencyCheck = checkReplannedDependencies(state, currentCell.cell, request);

      if (dependencyCheck._tag === "Mismatch") {
        yield* markCellInvalid(state, currentCell.cell, dependencyCheck.failure);
        return yield* handleOf(currentCell.cell);
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
      return yield* handleOf(currentCell);
    }

    recordCellDependencies(state, nodeId, plannedDependencies.value);

    const plannedCell = lookupGraphNodeCell(state, nodeId);

    return plannedCell._tag === "Missing"
      ? unwiredNodeRead(nodeId)
      : yield* handleOf(plannedCell.cell);
  });
}

function planDependencies(input: {
  readonly state: GraphPlanState;
  readonly descriptor: NodeDescriptor;
  readonly request: NodeRequest;
  readonly nodeId: NodeId;
  readonly visiting: ReadonlyArray<NodeId>;
}): Effect.Effect<
  GraphOutcome<Record<string, NodeId>, DependencyDefinitionFailed | DependencyDefinitionFailures>
> {
  return Effect.gen(function* () {
    const dependencies = dependenciesResult(input.descriptor, input.request, input.nodeId);

    if (dependencies._tag === "Failure") {
      return graphFailure(dependencies.failure);
    }

    const dependencyRequests = dependencyRequestsFor(
      input.nodeId,
      input.descriptor.tag,
      dependencies.value
    );

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

function dependencyRequestsFor(
  nodeId: NodeId,
  tag: string,
  dependencies: Record<string, Dependency<unknown>>
): GraphOutcome<
  ReadonlyArray<{
    readonly name: string;
    readonly request: NodeRequest;
  }>,
  DependencyDefinitionFailed | DependencyDefinitionFailures
> {
  const results = Object.entries(dependencies).map(([dependencyName, dependency]) => ({
    dependencyName,
    result: dependencyRequestResult(dependency, {
      nodeId,
      tag,
      dependency: dependencyName,
    }),
  }));
  const failures = results.flatMap(({ result }) =>
    result._tag === "Failure" ? [result.failure] : []
  );
  const failure = dependencyDefinitionFailuresFor(nodeId, tag, failures);

  if (failure !== undefined) {
    return graphFailure(failure);
  }

  return graphSuccess(
    results.flatMap(({ dependencyName, result }) =>
      result._tag === "Success" ? [{ name: dependencyName, request: result.value }] : []
    )
  );
}

type ReplanDependencyCheck =
  | { readonly _tag: "Proceed" }
  | { readonly _tag: "Mismatch"; readonly failure: GraphInvariantViolation };

function checkReplannedDependencies(
  state: GraphPlanState,
  cell: GraphNodeCell,
  request: NodeRequest
): ReplanDependencyCheck {
  // Mirror of validateStaticDependencies in operations/argsOperation: compute
  // the dependency ids the new request would wire without planning them.
  // Malformed dependency records proceed so wiring reports its own structured
  // definition failures instead of a misleading mismatch.
  try {
    const dependencies = cell.descriptor.dependencies(request.args);

    if (!isDependencyRecord(dependencies)) {
      return { _tag: "Proceed" };
    }

    const dependencyIds: Record<string, NodeId> = {};

    for (const [dependencyName, dependency] of Object.entries(dependencies)) {
      if (dependency.type !== "dependency" || !isFrondNodeSpec(dependency.spec)) {
        return { _tag: "Proceed" };
      }

      dependencyIds[dependencyName] = resolveEffectiveNodeId(state, {
        spec: dependency.spec,
        args: dependency.args,
      });
    }

    if (sameDependencyIds(cell.dependencies, dependencyIds)) {
      return { _tag: "Proceed" };
    }

    return {
      _tag: "Mismatch",
      failure: new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "same-identity re-plan cannot change static dependencies",
        cause: {
          currentDependencies: cell.dependencies,
          nextDependencies: dependencyIds,
        },
      }),
    };
  } catch {
    return { _tag: "Proceed" };
  }
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

export function sameDependencyIds(
  left: Readonly<Record<string, NodeId>>,
  right: Readonly<Record<string, NodeId>>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || left[key] !== right[key]) {
      return false;
    }
  }

  return true;
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

type KeyResolutionFailure = {
  readonly key: NodeKey;
  readonly failure: KeyBuildFailed;
};

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

function resolveKey(
  descriptor: NodeDescriptor,
  request: NodeRequest
): GraphOutcome<NodeKey, KeyResolutionFailure> {
  try {
    return graphSuccess(canonicalKey(descriptor.key(request.args)));
  } catch (cause) {
    const key = invalidKey(cause);
    const nodeId = makeNodeId(descriptor.tag, key);

    return graphFailure({
      key,
      failure: new KeyBuildFailed({
        nodeId,
        tag: descriptor.tag,
        cause,
      }),
    });
  }
}

function invalidKey(cause: unknown): NodeKey {
  return `__invalid__:${safeFailureLabel(cause)}` as NodeKey;
}

function safeFailureLabel(cause: unknown): string {
  const text = cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause);

  return text.replaceAll(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 180);
}

function duplicateTagSpec(state: GraphPlanState, tag: string, spec: unknown): boolean {
  const existing = state.specByTag.get(tag);

  return existing !== undefined && existing !== spec;
}

function dependenciesResult(
  descriptor: NodeDescriptor,
  request: NodeRequest,
  nodeId: NodeId
): GraphOutcome<Record<string, Dependency<unknown>>, DependencyDefinitionFailed> {
  try {
    const dependencies = descriptor.dependencies(request.args);

    if (!isDependencyRecord(dependencies)) {
      return graphFailure(
        new DependencyDefinitionFailed({
          nodeId,
          tag: descriptor.tag,
          cause: new GraphInvariantViolation({
            nodeId,
            tag: descriptor.tag,
            invariant: "dependencies must return an object record",
            cause: { dependencies },
          }),
        })
      );
    }

    return graphSuccess(dependencies);
  } catch (cause) {
    return graphFailure(
      new DependencyDefinitionFailed({
        nodeId,
        tag: descriptor.tag,
        cause,
      })
    );
  }
}

function dependencyRequestResult(
  dependency: Dependency<unknown>,
  context: {
    readonly nodeId: NodeId;
    readonly tag: string;
    readonly dependency: string;
  }
): GraphOutcome<NodeRequest, DependencyDefinitionFailed> {
  try {
    if (dependency.type !== "dependency") {
      return graphFailure(
        new DependencyDefinitionFailed({
          nodeId: context.nodeId,
          tag: context.tag,
          dependency: context.dependency,
          cause: new GraphInvariantViolation({
            nodeId: context.nodeId,
            tag: context.tag,
            invariant: "dependency record entry must be a dependency",
            cause: { dependency: context.dependency },
          }),
        })
      );
    }

    const request = {
      spec: dependency.spec,
      args: dependency.args,
    };

    if (!isFrondNodeSpec(request.spec)) {
      return graphFailure(
        new DependencyDefinitionFailed({
          nodeId: context.nodeId,
          tag: context.tag,
          dependency: context.dependency,
          cause: new GraphInvariantViolation({
            nodeId: context.nodeId,
            tag: context.tag,
            invariant: "dependency node spec must be a Frond node spec",
            cause: { dependency: context.dependency },
          }),
        })
      );
    }

    return graphSuccess(request);
  } catch (cause) {
    return graphFailure(
      new DependencyDefinitionFailed({
        nodeId: context.nodeId,
        tag: context.tag,
        dependency: context.dependency,
        cause,
      })
    );
  }
}

function dependencyDefinitionFailuresFor(
  nodeId: NodeId,
  tag: string,
  failures: ReadonlyArray<DependencyDefinitionFailed>
): DependencyDefinitionFailed | DependencyDefinitionFailures | undefined {
  if (failures.length === 0) {
    return undefined;
  }

  if (failures.length === 1) {
    return failures[0];
  }

  return new DependencyDefinitionFailures({
    nodeId,
    tag,
    failures: failures as readonly [DependencyDefinitionFailed, ...DependencyDefinitionFailed[]],
  });
}

function makeEdgeKey(from: NodeId, dependency: string): string {
  return [from, dependency].join(EDGE_KEY_SEPARATOR);
}

function isDependencyRecord(value: unknown): value is Record<string, Dependency<unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const latest = yield* cell.state.get;
    const ready = phaseReadyData(latest.phase);

    // Contract: invalidating a ready cell discards its ready generation, so it
    // must run the full teardown (live stop, driver release, disposers) before
    // the Invalid transition makes the ready data unreachable.
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

    yield* cell.state.transition((latest) => [undefined, markInvalidState({ latest, failure })]);
  });
}
