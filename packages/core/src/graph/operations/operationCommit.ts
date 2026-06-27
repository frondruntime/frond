import { Effect } from "effect";
import { phaseArgs } from "../cell/cellPhase";
import { appendReadyDisposersState, commitReadyOperationState } from "../cell/cellTransitions";
import type { GraphNodeCell } from "../planning/plan";
import { updateReadyNodeRuntimeState } from "../planning/readyNodeRuntime";
import { type ResultState, validityChanged } from "../resultValidity";
import type { ResultValidity, ResultValidityChangedReason } from "../types";

export function commitReadyOperationResult(input: {
  readonly cell: GraphNodeCell;
  readonly node: object;
  readonly deps: Record<string, object>;
  readonly resultState: ResultState;
  readonly previousValidity: ResultValidity;
  readonly validityReason: ResultValidityChangedReason;
  readonly operationDisposers: ReadonlyArray<() => void>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const latest = yield* input.cell.state.get;
    updateReadyNodeRuntimeState({
      node: input.node,
      args: phaseArgs(latest.phase),
      deps: input.deps,
      result: input.resultState.result,
    });
    yield* input.cell.state.transition((latest) => [
      undefined,
      commitReadyOperationState({
        latest,
        deps: input.deps,
        resultState: input.resultState,
        operationDisposers: input.operationDisposers,
      }),
    ]);

    if (validityChanged(input.previousValidity, input.resultState.resultValidity)) {
      yield* input.cell.notifyResultValidityChanged(
        input.cell.nodeId,
        input.previousValidity,
        input.resultState.resultValidity,
        input.validityReason
      );
    }
  });
}

export function appendOperationDisposers(
  cell: GraphNodeCell,
  operationDisposers: ReadonlyArray<() => void>
): Effect.Effect<void> {
  return operationDisposers.length === 0
    ? Effect.void
    : cell.state.transition((latest) => [
        undefined,
        appendReadyDisposersState({ latest, operationDisposers }),
      ]);
}
