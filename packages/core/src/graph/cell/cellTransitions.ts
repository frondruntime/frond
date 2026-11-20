import type { Disposer } from "../../driver";
import type { DisposerRegistry } from "../lifecycle/disposers";
import type { ResultState } from "../resultValidity";
import type {
  GraphFailure,
  NodeOperationFailure,
  NormalizedResultValidityPolicy,
  ResultValidity,
} from "../types";
import type { GraphNodeState } from "./cellModel";
import {
  type ActiveCellOperation,
  acquiringCell,
  type CellBase,
  type CellReadinessAttempt,
  idleCell,
  invalidCell,
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
  input.latest.nextAttemptId = input.attemptId;
  input.latest.phase = acquiringCell(input.base, input.attempt);
  return input.latest;
}

export function failReadinessAttemptState(input: {
  readonly latest: GraphNodeState;
  readonly cause: unknown;
  readonly resultValidity?: ResultValidity | undefined;
}): GraphNodeState {
  if (input.latest.phase._tag === "Acquiring") {
    const base = input.latest.phase.base;
    // A failed re-acquire drops the expired incarnation's result: no later
    // acquire may retain it as an equal result.
    input.latest.phase = readinessErrorCell(
      base.previousResult === undefined
        ? baseWithResultValidity(base, input.resultValidity)
        : {
            args: base.args,
            liveLeases: base.liveLeases,
            liveFailure: base.liveFailure,
            resultValidity: input.resultValidity ?? base.resultValidity,
          },
      input.cause
    );
  }
  return input.latest;
}

export function completeAcquireState(input: {
  readonly latest: GraphNodeState;
  readonly attempt: CellReadinessAttempt;
  readonly ready: {
    readonly node: object;
    readonly args: unknown;
    readonly deps: Record<string, object>;
    readonly resultState: ResultState;
    readonly resultValidityPolicy: NormalizedResultValidityPolicy;
    readonly disposers: DisposerRegistry;
    readonly nodeLifetime: AbortController;
  };
}):
  | { readonly _tag: "Committed"; readonly state: GraphNodeState }
  | { readonly _tag: "Stale"; readonly state: GraphNodeState } {
  if (
    input.latest.phase._tag !== "Acquiring" ||
    input.latest.phase.attempt.attemptId !== input.attempt.attemptId
  ) {
    return { _tag: "Stale", state: input.latest };
  }

  input.latest.phase = readyCell({
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
    nodeLifetime: input.ready.nodeLifetime,
  });
  return { _tag: "Committed", state: input.latest };
}

export function beginNodeOperationState(input: {
  readonly latest: GraphNodeState;
  readonly operation: ActiveCellOperation;
}): GraphNodeState {
  input.latest.nextOperationId = input.operation.operationId + 1;
  if (input.latest.phase._tag === "Ready") {
    input.latest.phase = operatingCell(input.latest.phase.ready, input.operation);
  }
  return input.latest;
}

export function completeNodeOperationState(input: {
  readonly latest: GraphNodeState;
  readonly operation: ActiveCellOperation;
}): GraphNodeState {
  // Refuse a late completion from an interrupted or overtaken operation.
  if (
    input.latest.phase._tag === "Operating" &&
    isCurrentOperation(input.latest.phase.operation, input.operation)
  ) {
    input.latest.phase = readyCell(input.latest.phase.ready);
  }
  return input.latest;
}

export function failNodeOperationState(input: {
  readonly latest: GraphNodeState;
  readonly operation: ActiveCellOperation;
  readonly failure: NodeOperationFailure;
}): GraphNodeState {
  if (
    input.latest.phase._tag === "Operating" &&
    isCurrentOperation(input.latest.phase.operation, input.operation)
  ) {
    input.latest.phase = readyCell(input.latest.phase.ready, input.failure);
  }
  return input.latest;
}

export function commitReadyOperationState(input: {
  readonly latest: GraphNodeState;
  readonly deps: Record<string, object>;
  readonly resultState: ResultState;
  readonly operationDisposers: ReadonlyArray<Disposer>;
}): GraphNodeState {
  const phase = input.latest.phase;
  if (phase._tag === "Ready" || phase._tag === "Operating") {
    const ready = phase.ready;
    ready.deps = input.deps;
    ready.result = input.resultState.result;
    ready.resultValidity = input.resultState.resultValidity;
    ready.resultLoadedAt = input.resultState.resultLoadedAt;
    appendReadyDisposers(ready.disposers, input.operationDisposers);
  }
  return input.latest;
}

export function appendReadyDisposersState(input: {
  readonly latest: GraphNodeState;
  readonly operationDisposers: ReadonlyArray<Disposer>;
}): GraphNodeState {
  const phase = input.latest.phase;
  if (phase._tag === "Ready" || phase._tag === "Operating") {
    appendReadyDisposers(phase.ready.disposers, input.operationDisposers);
  }
  return input.latest;
}

// Ownership: ready disposers live in the incarnation registry handed off by
// the acquire operation bag. Append into it and keep the identity so late adds
// through the bag and the teardown drain loop share one registry.
function appendReadyDisposers(
  current: DisposerRegistry,
  appended: ReadonlyArray<Disposer>
): DisposerRegistry {
  current.append(appended);
  return current;
}

export function completeReleaseState(input: {
  readonly latest: GraphNodeState;
  readonly cleanupFailures: ReadonlyArray<GraphFailure>;
}): GraphNodeState {
  const failure = input.cleanupFailures[0];
  const base = phaseBase(input.latest.phase);

  // Release retains identity; eviction removes the graph record.
  if (base._tag === "Found") input.latest.phase = idleCell(base.base, failure);
  return input.latest;
}

export function markInvalidState(input: {
  readonly latest: GraphNodeState;
  readonly failure: unknown;
}): GraphNodeState {
  const base = phaseBase(input.latest.phase);

  input.latest.phase =
    base._tag === "Found" ? invalidCell(input.failure, base.base) : invalidCell(input.failure);
  return input.latest;
}

function baseWithResultValidity(
  base: CellBase,
  resultValidity: ResultValidity | undefined
): CellBase {
  if (resultValidity === undefined) {
    return base;
  }

  return {
    args: base.args,
    liveLeases: base.liveLeases,
    liveFailure: base.liveFailure,
    resultValidity,
  };
}

function isCurrentOperation(current: ActiveCellOperation, operation: ActiveCellOperation): boolean {
  return current.operationId === operation.operationId;
}
