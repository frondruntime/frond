import { Clock, Effect, Match } from "effect";
import type { RuntimeSignalAccess } from "../../signals";
import type { GraphCellTask } from "../cell/cellActor";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import { phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import type { GraphRuntimeSpanAttributes } from "../config";
import type { GraphNodeCell, GraphPlanState } from "../planning/plan";
import { effectiveResultValidity } from "../resultValidity";
import {
  DependencyFailed,
  DependencyFailures,
  DependencyRefreshFailed,
  DependencyResultExpired,
  type DriverOperationTimeouts,
  GraphInvariantViolation,
  type NodeRead,
  type RefreshResult,
  type RefreshSubmission,
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
  readonly submitEnsureReadyByNodeId: (
    nodeId: NodeRead["nodeId"]
  ) => Effect.Effect<EnsureReadyDependencySubmission>;
  readonly submitRefreshByNodeId: (nodeId: NodeRead["nodeId"]) => Effect.Effect<RefreshSubmission>;
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

export function ensureDependencyNodes(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell
): Effect.Effect<Record<string, object>, DependencyFailed | DependencyFailures> {
  return Effect.gen(function* () {
    const dependencyEntries = Object.entries(cell.dependencies);
    const submissions = yield* Effect.forEach(
      dependencyEntries,
      ([dependencyName, dependencyNodeId]) =>
        env.submitEnsureReadyByNodeId(dependencyNodeId).pipe(
          Effect.map((submission) => ({
            dependencyName,
            dependencyNodeId,
            submission,
          }))
        ),
      { concurrency: "unbounded" }
    );
    const dependencyResults = yield* Effect.forEach(
      submissions,
      (submission) => captureDependencyValue(readyDependencyValue(cell, submission)),
      { concurrency: "unbounded" }
    );

    return yield* finishDependencyValues(cell, dependencyResults);
  });
}

function readyDependencyValue(
  cell: GraphNodeCell,
  input: {
    readonly dependencyName: string;
    readonly dependencyNodeId: NodeRead["nodeId"];
    readonly submission: EnsureReadyDependencySubmission;
  }
): Effect.Effect<readonly [string, object], DependencyFailed> {
  return Effect.gen(function* () {
    const { dependencyName, dependencyNodeId, submission } = input;
    const dependencyHandle = yield* Match.value(submission).pipe(
      Match.tag("Submitted", ({ task }) => task.await),
      Match.tag("Missing", () =>
        Effect.fail(
          new DependencyFailed({
            nodeId: cell.nodeId,
            tag: cell.tag,
            dependency: dependencyName,
            dependencyNodeId,
            cause: new GraphInvariantViolation({
              nodeId: dependencyNodeId,
              tag: "unknown",
              invariant: "dependency cell must exist before dependency readiness awaits",
            }),
          })
        )
      ),
      Match.exhaustive
    );

    if (dependencyHandle.status._tag !== "Wired" || dependencyHandle.status.run._tag !== "Ready") {
      return yield* new DependencyFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        dependency: dependencyName,
        dependencyNodeId,
        cause: dependencyStatusCause(dependencyHandle),
      });
    }

    if (dependencyHandle.resultValidity?._tag === "Expired") {
      return yield* new DependencyFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        dependency: dependencyName,
        dependencyNodeId,
        cause: new DependencyResultExpired({
          nodeId: dependencyNodeId,
          tag: dependencyHandle.tag ?? "unknown",
          resultValidity: dependencyHandle.resultValidity,
        }),
      });
    }

    if (dependencyHandle._tag !== "Ready") {
      return yield* new DependencyFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        dependency: dependencyName,
        dependencyNodeId,
        cause: new GraphInvariantViolation({
          nodeId: dependencyNodeId,
          tag: "unknown",
          invariant: "ready dependency must expose graph-owned node object",
        }),
      });
    }

    return [dependencyName, dependencyHandle.node] as const;
  });
}

function dependencyStatusCause(dependencyHandle: NodeRead): unknown {
  if (dependencyHandle.status._tag === "Invalid") {
    return dependencyHandle.status.error;
  }

  if (dependencyHandle.status._tag === "Wired" && dependencyHandle.status.run._tag === "Error") {
    return dependencyHandle.status.run.error;
  }

  return dependencyHandle.status;
}

export function collectDependencyValues(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell
): Effect.Effect<Record<string, object>, DependencyFailed | DependencyFailures> {
  return Effect.gen(function* () {
    const dependencyResults: Array<DependencyValueResult> = [];

    for (const [dependencyName, dependencyNodeId] of Object.entries(cell.dependencies)) {
      dependencyResults.push(
        yield* captureDependencyValue(
          currentDependencyValue(env, cell, dependencyName, dependencyNodeId)
        )
      );
    }

    return yield* finishDependencyValues(cell, dependencyResults);
  });
}

export function refreshDependencyValue(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  dependencyName: string
): Effect.Effect<object, DependencyRefreshFailed | GraphInvariantViolation> {
  return Effect.gen(function* () {
    const dependencyNodeId = cell.dependencies[dependencyName];

    if (dependencyNodeId === undefined || !Object.hasOwn(cell.dependencies, dependencyName)) {
      return yield* new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "driver refreshDep requires a declared dependency name",
        cause: { dependency: dependencyName },
      });
    }

    const submission = yield* env.submitRefreshByNodeId(dependencyNodeId);
    const refreshResult = yield* submissionResult(submission);

    if (refreshResult._tag === "Failure") {
      return yield* dependencyRefreshFailed(
        cell,
        dependencyName,
        dependencyNodeId,
        refreshResult.error
      );
    }

    const dependencyValue = yield* currentDependencyValue(
      env,
      cell,
      dependencyName,
      dependencyNodeId
    ).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          dependencyRefreshFailed(cell, dependencyName, dependencyNodeId, cause),
        onSuccess: (value) => Effect.succeed(value),
      })
    );

    return dependencyValue[1];
  });
}

function submissionResult(submission: RefreshSubmission): Effect.Effect<RefreshResult> {
  if (submission._tag === "Missing") {
    return Effect.succeed(submission.result);
  }

  return submission.task.await;
}

function dependencyRefreshFailed(
  cell: GraphNodeCell,
  dependencyName: string,
  dependencyNodeId: NodeRead["nodeId"],
  cause: unknown
): Effect.Effect<never, DependencyRefreshFailed> {
  return Effect.fail(
    new DependencyRefreshFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      dependency: dependencyName,
      dependencyNodeId,
      cause,
    })
  );
}

function captureDependencyValue(
  value: Effect.Effect<DependencyValue, DependencyFailed>
): Effect.Effect<DependencyValueResult> {
  return value.pipe(
    Effect.match({
      onFailure: (failure) => ({ _tag: "Failure", failure }) as const,
      onSuccess: (entry) => ({ _tag: "Success", value: entry }) as const,
    })
  );
}

function finishDependencyValues(
  cell: GraphNodeCell,
  results: ReadonlyArray<DependencyValueResult>
): Effect.Effect<Record<string, object>, DependencyFailed | DependencyFailures> {
  const failures: Array<DependencyFailed> = [];
  const deps: Record<string, object> = {};

  for (const result of results) {
    if (result._tag === "Failure") {
      failures.push(result.failure);
      continue;
    }

    const [dependencyName, dependencyNode] = result.value;
    deps[dependencyName] = dependencyNode;
  }

  const dependencyFailure = dependencyFailures(cell, failures);

  if (dependencyFailure !== undefined) {
    return Effect.fail(dependencyFailure);
  }

  return Effect.succeed(deps);
}

function currentDependencyValue(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  dependencyName: string,
  dependencyNodeId: NodeRead["nodeId"]
): Effect.Effect<readonly [string, object], DependencyFailed> {
  return Effect.gen(function* () {
    const dependencyCell = lookupGraphNodeCell(env.state, dependencyNodeId);

    if (dependencyCell._tag === "Missing") {
      return yield* new DependencyFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        dependency: dependencyName,
        dependencyNodeId,
        cause: new GraphInvariantViolation({
          nodeId: dependencyNodeId,
          tag: "unknown",
          invariant: "dependency cell must exist before dependency value collection",
        }),
      });
    }

    const dependencyState = yield* dependencyCell.cell.state.get;
    const dependencyProjection = projectCellPhase(dependencyState.phase);

    if (
      dependencyProjection._tag === "Removed" ||
      dependencyProjection.status._tag !== "Wired" ||
      dependencyProjection.status.run._tag !== "Ready"
    ) {
      return yield* new DependencyFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        dependency: dependencyName,
        dependencyNodeId,
        cause:
          dependencyProjection._tag === "Removed"
            ? { _tag: "Unwired" }
            : dependencyProjection.status,
      });
    }

    const dependencyReady = phaseReadyData(dependencyState.phase);

    if (dependencyReady._tag === "Missing") {
      return yield* new DependencyFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        dependency: dependencyName,
        dependencyNodeId,
        cause: new GraphInvariantViolation({
          nodeId: dependencyNodeId,
          tag: "unknown",
          invariant: "ready dependency must expose graph-owned node object",
        }),
      });
    }

    // Guard: time-bound expiry is computed lazily, so the stored validity tag
    // can still read Current after the clock passed expireAfter. Evaluate the
    // effective validity here so an action/refresh never consumes
    // clock-expired dependency data.
    const now = yield* Clock.currentTimeMillis;
    const dependencyValidity = effectiveResultValidity(
      dependencyReady.ready.resultValidity,
      dependencyReady.ready.resultValidityPolicy,
      dependencyReady.ready.resultLoadedAt,
      now
    );

    if (dependencyValidity._tag === "Expired") {
      return yield* new DependencyFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        dependency: dependencyName,
        dependencyNodeId,
        cause: new DependencyResultExpired({
          nodeId: dependencyNodeId,
          tag: dependencyCell.cell.tag,
          resultValidity: dependencyValidity,
        }),
      });
    }

    return [dependencyName, dependencyReady.ready.node] as const;
  });
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
