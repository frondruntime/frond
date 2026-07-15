import { Effect } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import {
  mapPhaseBase,
  mapPhaseReady,
  phaseArgs,
  phaseReadyData,
  projectCellPhase,
} from "../cell/cellPhase";
import { resolveStaticDependencyIds } from "../planning/dependencyDefinitions";
import { type GraphOutcome, graphFailure, graphSuccess } from "../planning/outcome";
import { updateReadyNodeRuntimeState } from "../planning/readyNodeRuntime";
import {
  GraphInvariantViolation,
  type UpdateNodeArgsRequest,
  type UpdateNodeArgsResult,
} from "../types";
import type { GraphOperationEnvironment } from "./dependencies";
import { makeUpdateArgsFailure } from "./operationFailures";
import { runBackgroundOperation } from "./operationState";
import { runRefreshDriver } from "./refreshOperation";

export function updateNodeArgsInCell(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: UpdateNodeArgsRequest
): Effect.Effect<UpdateNodeArgsResult> {
  return runBackgroundOperation(cell, "args", () => reconcileNodeArgs(env, cell, request));
}

function reconcileNodeArgs(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: UpdateNodeArgsRequest
): Effect.Effect<UpdateNodeArgsResult> {
  return Effect.gen(function* () {
    const sameDependencies = validateStaticDependencies(env, cell, request.args);

    if (sameDependencies._tag === "Failure") {
      return makeUpdateArgsFailure(cell, request, sameDependencies.failure);
    }

    const current = yield* cell.state.get;
    const projection = projectCellPhase(current.phase);

    if (projection._tag === "Removed" || projection.status._tag !== "Wired") {
      return makeUpdateArgsFailure(
        cell,
        request,
        projection._tag === "Removed" ? { _tag: "Unwired" } : projection.status
      );
    }

    const currentReady = phaseReadyData(current.phase);

    if (currentReady._tag === "Found") {
      updateReadyNodeRuntimeState({ node: currentReady.ready.node, args: request.args });
    }

    yield* cell.state.transition((latest) => [
      undefined,
      {
        ...latest,
        phase: mapPhaseBase(latest.phase, (base) => ({ ...base, args: request.args })),
      },
    ]);

    const { refresh } = cell.descriptor.driver;
    const shouldRefresh = projection.status.run._tag === "Ready" && refresh._tag === "Available";

    if (shouldRefresh) {
      const previousReady = phaseReadyData(current.phase);
      const refreshResult = yield* runRefreshDriver(env, cell, {
        target: {
          _tag: "NodeId",
          nodeId: cell.nodeId,
        },
      });

      if (refreshResult._tag === "Failure") {
        const previousArgs = phaseArgs(current.phase);

        if (previousReady._tag === "Found") {
          updateReadyNodeRuntimeState({
            node: previousReady.ready.node,
            args: previousArgs,
            result: previousReady.ready.result,
          });
        }
        yield* cell.state.transition((latest) => [
          undefined,
          {
            ...latest,
            phase:
              previousReady._tag === "Missing"
                ? mapPhaseBase(latest.phase, (base) => ({ ...base, args: previousArgs }))
                : mapPhaseReady(
                    mapPhaseBase(latest.phase, (base) => ({ ...base, args: previousArgs })),
                    (readyData) => ({
                      ...readyData,
                      result: previousReady.ready.result,
                      resultValidity: previousReady.ready.resultValidity,
                      resultLoadedAt: previousReady.ready.resultLoadedAt,
                    })
                  ),
          },
        ]);
        return makeUpdateArgsFailure(cell, request, refreshResult.error);
      }
    }

    return {
      _tag: "Success",
      nodeId: cell.nodeId,
      shouldRefresh,
    } satisfies UpdateNodeArgsResult;
  });
}

function validateStaticDependencies(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  args: unknown
): GraphOutcome<void, unknown> {
  const dependencyIds = resolveStaticDependencyIds(
    env.state,
    cell,
    args,
    (dependencyName) =>
      new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "same-identity args dependency record must be a dependency",
        cause: { dependency: dependencyName },
      })
  );

  if (dependencyIds._tag === "Malformed") {
    return graphFailure(dependencyIds.cause);
  }

  if (dependencyIds._tag === "Changed") {
    return graphFailure(
      new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "same-identity args update cannot change static dependencies",
        cause: {
          currentDependencies: dependencyIds.currentIds,
          nextDependencies: dependencyIds.nextIds,
        },
      })
    );
  }

  return graphSuccess(undefined);
}
