import type { GraphNodeState } from "../planning/plan";
import type { ResultState } from "../resultValidity";
import type {
  GraphFailure,
  NodeOperationFailure,
  NormalizedResultValidityPolicy,
  ResultValidity,
} from "../types";
import {
  type ActiveCellOperation,
  acquiringCell,
  type CellBase,
  type CellReadinessAttempt,
  idleCell,
  invalidCell,
  mapPhaseReady,
  operatingCell,
  phaseBase,
  phaseLiveLeases,
  readinessErrorCell,
  readyCell,
} from "./cellPhase";

// Owner: this module owns graph-cell lifecycle state transitions. Operation
// modules may gather data and run drivers, but committed phase changes should
// flow through these named helpers.

export function beginReadinessAttemptState(input: {
  readonly latest: GraphNodeState;
  readonly attemptId: number;
  readonly base: CellBase;
  readonly attempt: CellReadinessAttempt;
}): GraphNodeState {
  return {
    ...input.latest,
    nextAttemptId: input.attemptId,
    phase: acquiringCell(input.base, input.attempt),
  };
}

export function failReadinessAttemptState(input: {
  readonly latest: GraphNodeState;
  readonly cause: unknown;
  readonly resultValidity?: ResultValidity | undefined;
}): GraphNodeState {
  return {
    ...input.latest,
    phase:
      input.latest.phase._tag === "Acquiring"
        ? readinessErrorCell(
            baseWithResultValidity(input.latest.phase.base, input.resultValidity),
            input.cause
          )
        : input.latest.phase,
  };
}

export function completeAcquireState(input: {
  readonly latest: GraphNodeState;
  readonly ready: {
    readonly node: object;
    readonly args: unknown;
    readonly deps: Record<string, object>;
    readonly resultState: ResultState;
    readonly resultValidityPolicy: NormalizedResultValidityPolicy;
    readonly disposers: ReadonlyArray<() => void>;
  };
}): GraphNodeState {
  return {
    ...input.latest,
    phase: readyCell({
      node: input.ready.node,
      args: input.ready.args,
      liveLeases: phaseLiveLeases(input.latest.phase),
      deps: input.ready.deps,
      result: input.ready.resultState.result,
      resultValidity: input.ready.resultState.resultValidity,
      resultLoadedAt: input.ready.resultState.resultLoadedAt,
      resultValidityPolicy: input.ready.resultValidityPolicy,
      disposers: input.ready.disposers,
      // Contract: a freshly ready node preserves accumulated live leases, but no
      // live resource exists until demand is delivered after the ready commit.
      liveResource: { _tag: "Inactive" },
    }),
  };
}

export function beginNodeOperationState(input: {
  readonly latest: GraphNodeState;
  readonly operation: ActiveCellOperation;
}): GraphNodeState {
  return {
    ...input.latest,
    nextOperationId: input.operation.operationId + 1,
    phase:
      input.latest.phase._tag === "Ready"
        ? operatingCell(input.latest.phase.ready, input.operation)
        : input.latest.phase,
  };
}

export function completeNodeOperationState(input: {
  readonly latest: GraphNodeState;
  readonly operation: ActiveCellOperation;
}): GraphNodeState {
  return {
    ...input.latest,
    // Hazard: late completion from an interrupted/overtaken operation must not
    // clear the current operation or overwrite its failure.
    phase:
      input.latest.phase._tag === "Operating" &&
      isCurrentOperation(input.latest.phase.operation, input.operation)
        ? readyCell(input.latest.phase.ready)
        : input.latest.phase,
  };
}

export function failNodeOperationState(input: {
  readonly latest: GraphNodeState;
  readonly operation: ActiveCellOperation;
  readonly failure: NodeOperationFailure;
}): GraphNodeState {
  return {
    ...input.latest,
    phase:
      input.latest.phase._tag === "Operating" &&
      isCurrentOperation(input.latest.phase.operation, input.operation)
        ? readyCell(input.latest.phase.ready, input.failure)
        : input.latest.phase,
  };
}

export function commitReadyOperationState(input: {
  readonly latest: GraphNodeState;
  readonly deps: Record<string, object>;
  readonly resultState: ResultState;
  readonly operationDisposers: ReadonlyArray<() => void>;
}): GraphNodeState {
  return {
    ...input.latest,
    phase: mapPhaseReady(input.latest.phase, (readyData) => ({
      ...readyData,
      deps: input.deps,
      result: input.resultState.result,
      resultValidity: input.resultState.resultValidity,
      resultLoadedAt: input.resultState.resultLoadedAt,
      disposers: [...readyData.disposers, ...input.operationDisposers],
    })),
  };
}

export function appendReadyDisposersState(input: {
  readonly latest: GraphNodeState;
  readonly operationDisposers: ReadonlyArray<() => void>;
}): GraphNodeState {
  return {
    ...input.latest,
    phase: mapPhaseReady(input.latest.phase, (readyData) => ({
      ...readyData,
      disposers: [...readyData.disposers, ...input.operationDisposers],
    })),
  };
}

export function completeReleaseState(input: {
  readonly latest: GraphNodeState;
  readonly cleanupFailures: ReadonlyArray<GraphFailure>;
}): GraphNodeState {
  const failure = input.cleanupFailures[0];
  const base = phaseBase(input.latest.phase);

  return {
    ...input.latest,
    // Contract: release returns to idle identity and retains the first cleanup
    // failure for projection/events; eviction is the operation that removes
    // graph records.
    phase: base._tag === "Missing" ? input.latest.phase : idleCell(base.base, failure),
  };
}

export function markInvalidState(input: {
  readonly latest: GraphNodeState;
  readonly failure: unknown;
}): GraphNodeState {
  const base = phaseBase(input.latest.phase);

  return {
    ...input.latest,
    phase:
      base._tag === "Found" ? invalidCell(input.failure, base.base) : invalidCell(input.failure),
  };
}

function baseWithResultValidity(
  base: CellBase,
  resultValidity: ResultValidity | undefined
): CellBase {
  if (resultValidity === undefined) {
    return base;
  }

  return { ...base, resultValidity };
}

function isCurrentOperation(current: ActiveCellOperation, operation: ActiveCellOperation): boolean {
  return current.operationId === operation.operationId;
}
