import { type Context, Effect, Exit } from "effect";
import type { RuntimeSignalAccess } from "../../signals";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import type { GraphNodeCell, GraphPlanState } from "../cell/cellModel";
import { phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import type { GraphCellTask } from "../cell/cellQueue";
import type { GraphRuntimeSpanAttributes } from "../config";
import { singleFailure } from "../driverExecution/causePolicy";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import { effectiveResultValidity } from "../resultValidity";
import type { CoreRefreshSubmission } from "../system/refreshAdmission";
import {
  DependencyFailed,
  DependencyFailures,
  DependencyRefreshFailed,
  DependencyResultExpired,
  type DriverOperationTimeouts,
  GraphInvariantViolation,
  type NodeRead,
  type NodeStatus,
  type RefreshResult,
} from "../types";

export type EnsureReadyDependencySubmission =
  | {
      readonly _tag: "Submitted";
      readonly nodeId: NodeRead["nodeId"];
      readonly task: GraphCellTask<NodeRead>;
    }
  | {
      readonly _tag: "Missing";
      readonly nodeId: NodeRead["nodeId"];
    };

export interface GraphOperationEnvironment {
  readonly runtimeSpanAttributes: GraphRuntimeSpanAttributes;
  readonly state: GraphPlanState;
  readonly submitEnsureReadyDirect: (
    nodeId: NodeRead["nodeId"],
    context: Context.Context<never> | undefined,
    resume: GraphResume<EnsureReadyDependencySubmission>
  ) => GraphCancel;
  readonly submitRefreshDirect: (
    nodeId: NodeRead["nodeId"],
    context: Context.Context<never> | undefined,
    resume: GraphResume<CoreRefreshSubmission>
  ) => GraphCancel;
  readonly driverTimeouts: DriverOperationTimeouts;
  readonly signals: RuntimeSignalAccess;
}

type DependencyValue = readonly [string, object];

type DependencyValueResult =
  | {
      readonly _tag: "Success";
      readonly value: DependencyValue;
    }
  | {
      readonly _tag: "Failure";
      readonly failure: DependencyFailed;
    };

/**
 * A dependent's collected dependency values. The sync path reads it directly;
 * only the async readiness path turns it into an Exit, at its resume edge.
 */
type DependencyValuesResult =
  | {
      readonly _tag: "Success";
      readonly value: Record<string, object>;
    }
  | {
      readonly _tag: "Failure";
      readonly failure: DependencyFailed | DependencyFailures;
    };

export function startDependencyNodes(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  context: Context.Context<never> | undefined,
  resume: GraphResume<Record<string, object>, DependencyFailed | DependencyFailures>
): GraphCancel {
  const names = Object.keys(cell.dependencies);
  if (names.length === 0) {
    resume(dependencyValuesExit(finishDependencyValues(cell, [])));
    return noCancel;
  }
  const results: DependencyValueResult[] = [];
  const cancels: GraphCancel[] = [];
  let remaining = names.length;
  let canceled = false;
  const done = (result: DependencyValueResult) => {
    if (canceled) return;
    results.push(result);
    remaining -= 1;
    if (remaining === 0) resume(dependencyValuesExit(finishDependencyValues(cell, results)));
  };
  for (const name of names) {
    const nodeId = cell.dependencies[name];
    if (nodeId === undefined) throw new Error("Declared dependency has no node id");
    cancels.push(
      env.submitEnsureReadyDirect(nodeId, context, (exit) => {
        if (canceled) return;
        if (exit._tag === "Failure") {
          done(dependencyFailure(cell, name, nodeId, singleFailure(exit.cause)));
          return;
        }
        const submission = exit.value;
        if (submission._tag === "Missing") {
          done(
            dependencyFailure(
              cell,
              name,
              nodeId,
              new GraphInvariantViolation({
                nodeId,
                tag: "unknown",
                invariant: "dependency cell must exist before dependency readiness awaits",
              })
            )
          );
          return;
        }
        cancels.push(
          submission.task.listen((exit) => {
            if (exit._tag === "Failure") {
              done(dependencyFailure(cell, name, nodeId, singleFailure(exit.cause)));
              return;
            }
            done(readyDependencyValue(cell, name, nodeId, exit.value));
          })
        );
      })
    );
  }
  return () => {
    canceled = true;
    return Effect.forEach(cancels, (cancel) => cancel(), { discard: true });
  };
}

function readyDependencyValue(
  cell: GraphNodeCell,
  name: string,
  nodeId: NodeRead["nodeId"],
  read: NodeRead
): DependencyValueResult {
  if (read.status._tag !== "Wired" || read.status.run._tag !== "Ready")
    return dependencyFailure(cell, name, nodeId, nodeStatusCause(read.status));
  if (read.resultValidity?._tag === "Expired")
    return dependencyFailure(
      cell,
      name,
      nodeId,
      new DependencyResultExpired({
        nodeId,
        tag: read.tag ?? "unknown",
        resultValidity: read.resultValidity,
      })
    );
  if (read._tag !== "Ready")
    return dependencyFailure(
      cell,
      name,
      nodeId,
      new GraphInvariantViolation({
        nodeId,
        tag: "unknown",
        invariant: "ready dependency must expose graph-owned node object",
      })
    );
  return { _tag: "Success", value: [name, read.node] };
}

/**
 * The failure a not-ready status carries, so a dependent wraps the dependency's
 * own failure object (the one its attempt reported) rather than the status.
 */
function nodeStatusCause(status: NodeStatus): unknown {
  if (status._tag === "Invalid") {
    return status.error;
  }

  if (status._tag === "Wired" && status.run._tag === "Error") {
    return status.run.error;
  }

  return status;
}

export function collectDependencyValuesSync(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell
): DependencyValuesResult {
  const results: DependencyValueResult[] = [];
  for (const name in cell.dependencies) {
    if (!Object.prototype.hasOwnProperty.call(cell.dependencies, name)) continue;
    const nodeId = cell.dependencies[name];
    if (nodeId === undefined) continue;
    results.push(currentDependencyValue(env, cell, name, nodeId));
  }
  return finishDependencyValues(cell, results);
}

export function startRefreshDependency(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  dependencyName: string,
  context: Context.Context<never> | undefined,
  resume: GraphResume<object, DependencyRefreshFailed | GraphInvariantViolation>
): GraphCancel {
  const nodeId = cell.dependencies[dependencyName];
  if (
    nodeId === undefined ||
    !Object.prototype.hasOwnProperty.call(cell.dependencies, dependencyName)
  ) {
    resume(
      Exit.fail(
        new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "driver refreshDep requires a declared dependency name",
          cause: { dependency: dependencyName },
        })
      )
    );
    return noCancel;
  }
  const fail = (cause: unknown) =>
    resume(
      Exit.fail(
        new DependencyRefreshFailed({
          nodeId: cell.nodeId,
          tag: cell.tag,
          dependency: dependencyName,
          dependencyNodeId: nodeId,
          cause,
        })
      )
    );
  const complete = (result: RefreshResult) => {
    if (result._tag === "Failure") {
      fail(result.error);
      return;
    }
    const value = currentDependencyValue(env, cell, dependencyName, nodeId);
    if (value._tag === "Failure") fail(value.failure);
    else resume(Exit.succeed(value.value[1]));
  };
  let cancelTask: GraphCancel | undefined;
  const cancelPlan = env.submitRefreshDirect(nodeId, context, (exit) => {
    if (exit._tag === "Failure") {
      resume(Exit.failCause(exit.cause));
      return;
    }
    const submission = exit.value;
    if (submission._tag === "Missing") {
      complete(submission.result);
      return;
    }
    cancelTask = submission.task.listen((exit) => {
      if (exit._tag === "Failure") resume(Exit.failCause(exit.cause));
      else complete(exit.value);
    });
  });
  return () => (cancelTask === undefined ? cancelPlan() : cancelTask());
}

function finishDependencyValues(
  cell: GraphNodeCell,
  results: ReadonlyArray<DependencyValueResult>
): DependencyValuesResult {
  const failures: Array<DependencyFailed> = [];
  const phase = cell.state.getSync().phase;
  const previousDeps =
    phase._tag === "Ready" || phase._tag === "Operating" ? phase.ready.deps : undefined;
  let sameDeps = previousDeps !== undefined;
  let previousCount = 0;
  if (previousDeps !== undefined) {
    for (const name in previousDeps) {
      if (Object.prototype.hasOwnProperty.call(previousDeps, name)) previousCount += 1;
    }
    sameDeps = previousCount === results.length;
  }

  for (const result of results) {
    if (result._tag === "Failure") {
      failures.push(result.failure);
      continue;
    }

    const [dependencyName, dependencyNode] = result.value;
    if (
      previousDeps === undefined ||
      !Object.prototype.hasOwnProperty.call(previousDeps, dependencyName) ||
      previousDeps[dependencyName] !== dependencyNode
    ) {
      sameDeps = false;
    }
  }

  const failure = dependencyFailures(cell, failures);

  if (failure !== undefined) {
    return { _tag: "Failure", failure };
  }

  // Dependency nodes are mutable. Their results changing does not replace a
  // dependency entry; only a different node instance changes the deps record.
  if (sameDeps && previousDeps !== undefined) return { _tag: "Success", value: previousDeps };

  const deps: Record<string, object> = {};
  for (const result of results) {
    if (result._tag === "Success") {
      deps[result.value[0]] = result.value[1];
    }
  }
  return { _tag: "Success", value: deps };
}

function dependencyValuesExit(
  result: DependencyValuesResult
): Exit.Exit<Record<string, object>, DependencyFailed | DependencyFailures> {
  return result._tag === "Success" ? Exit.succeed(result.value) : Exit.fail(result.failure);
}

function currentDependencyValue(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  dependencyName: string,
  dependencyNodeId: NodeRead["nodeId"]
): DependencyValueResult {
  const dependencyCell = lookupGraphNodeCell(env.state, dependencyNodeId);

  if (dependencyCell._tag === "Missing") {
    return dependencyFailure(
      cell,
      dependencyName,
      dependencyNodeId,
      new GraphInvariantViolation({
        nodeId: dependencyNodeId,
        tag: "unknown",
        invariant: "dependency cell must exist before dependency value collection",
      })
    );
  }

  const dependencyState = dependencyCell.cell.state.getSync();
  const dependencyProjection = projectCellPhase(dependencyState.phase);

  if (
    dependencyProjection._tag === "Removed" ||
    dependencyProjection.status._tag !== "Wired" ||
    dependencyProjection.status.run._tag !== "Ready"
  ) {
    return dependencyFailure(
      cell,
      dependencyName,
      dependencyNodeId,
      dependencyProjection._tag === "Removed"
        ? { _tag: "Unwired" }
        : nodeStatusCause(dependencyProjection.status)
    );
  }

  const dependencyReady = phaseReadyData(dependencyState.phase);

  if (dependencyReady._tag === "Missing") {
    return dependencyFailure(
      cell,
      dependencyName,
      dependencyNodeId,
      new GraphInvariantViolation({
        nodeId: dependencyNodeId,
        tag: "unknown",
        invariant: "ready dependency must expose graph-owned node object",
      })
    );
  }

  // Guard: time-bound expiry is computed lazily, so the stored validity tag
  // can still read Current after the clock passed expireAfter. Evaluate the
  // effective validity here so an action/refresh never consumes
  // clock-expired dependency data.
  const now = cell.syncClock.now();
  const dependencyValidity = effectiveResultValidity(
    dependencyReady.ready.resultValidity,
    dependencyReady.ready.resultValidityPolicy,
    dependencyReady.ready.resultLoadedAt,
    now
  );

  if (dependencyValidity._tag === "Expired") {
    return dependencyFailure(
      cell,
      dependencyName,
      dependencyNodeId,
      new DependencyResultExpired({
        nodeId: dependencyNodeId,
        tag: dependencyCell.cell.tag,
        resultValidity: dependencyValidity,
      })
    );
  }

  return { _tag: "Success", value: [dependencyName, dependencyReady.ready.node] };
}

function dependencyFailure(
  cell: GraphNodeCell,
  dependency: string,
  dependencyNodeId: NodeRead["nodeId"],
  cause: unknown
): DependencyValueResult {
  return {
    _tag: "Failure",
    failure: new DependencyFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      dependency,
      dependencyNodeId,
      cause,
    }),
  };
}

function dependencyFailures(
  cell: GraphNodeCell,
  failures: ReadonlyArray<DependencyFailed>
): DependencyFailed | DependencyFailures | undefined {
  if (failures.length === 0) {
    return undefined;
  }

  if (failures.length === 1) {
    return failures[0];
  }

  return new DependencyFailures({
    nodeId: cell.nodeId,
    tag: cell.tag,
    failures: failures as readonly [DependencyFailed, ...DependencyFailed[]],
  });
}
