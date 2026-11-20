import { type Context, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseArgs, phaseBase, phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import { resolveStaticDependencyIds } from "../planning/dependencyDefinitions";
import { type GraphOutcome, graphFailure, graphSuccess } from "../planning/outcome";
import { updateReadyNodeRuntimeState } from "../planning/readyNodeRuntime";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import {
  GraphInvariantViolation,
  type UpdateNodeArgsRequest,
  type UpdateNodeArgsResult,
} from "../types";
import type { GraphOperationEnvironment } from "./dependencies";
import { makeUpdateArgsFailure } from "./operationFailures";
import { startBackgroundOperation } from "./operationState";
import { startRefreshDriver } from "./refreshOperation";

export function updateNodeArgsInCell(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: UpdateNodeArgsRequest,
  context: Context.Context<never> | undefined,
  resume: GraphResume<UpdateNodeArgsResult>
): GraphCancel {
  const sameDependencies = validateStaticDependencies(env, cell, request.args);
  const phase = cell.state.getSync().phase;
  const projection = projectCellPhase(phase);
  const failure =
    sameDependencies._tag === "Failure"
      ? sameDependencies.failure
      : projection._tag === "Removed"
        ? { _tag: "Unwired" }
        : projection.status._tag !== "Wired"
          ? projection.status
          : undefined;
  if (failure !== undefined)
    return startBackgroundOperation(
      cell,
      "args",
      (_operation, done) => {
        done(Exit.succeed(makeUpdateArgsFailure(cell, request, failure)));
        return noCancel;
      },
      context,
      resume
    );
  const ready = phaseReadyData(phase);
  const previousArgs = phaseArgs(phase);
  setArgs(cell, request.args);
  const shouldRefresh =
    ready._tag === "Found" && cell.descriptor.driver.refresh._tag === "Available";
  return startBackgroundOperation(
    cell,
    "args",
    (_operation, done) => {
      if (!shouldRefresh) {
        done(Exit.succeed({ _tag: "Success", nodeId: cell.nodeId, shouldRefresh }));
        return noCancel;
      }
      return startRefreshDriver(
        env,
        cell,
        { target: { _tag: "NodeId", nodeId: cell.nodeId } },
        context,
        (exit) => {
          if (exit._tag === "Failure") {
            done(Exit.failCause(exit.cause));
            return;
          }
          if (exit.value._tag === "Failure") {
            setArgs(cell, previousArgs);
            done(Exit.succeed(makeUpdateArgsFailure(cell, request, exit.value.error)));
          } else done(Exit.succeed({ _tag: "Success", nodeId: cell.nodeId, shouldRefresh }));
        }
      );
    },
    context,
    resume
  );
}

function setArgs(cell: GraphNodeCell, args: unknown): void {
  cell.state.updateSync((latest) => {
    const ready = phaseReadyData(latest.phase);
    if (ready._tag === "Found") ready.ready.args = args;
    else {
      const base = phaseBase(latest.phase);
      if (base._tag === "Found") base.base.args = args;
    }
  });
  const ready = phaseReadyData(cell.state.getSync().phase);
  if (ready._tag === "Found") updateReadyNodeRuntimeState({ node: ready.ready.node, args });
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
