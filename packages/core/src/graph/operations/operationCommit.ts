import type { Disposer } from "../../driver";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseArgs } from "../cell/cellPhase";
import { appendReadyDisposersState, commitReadyOperationState } from "../cell/cellTransitions";
import { updateReadyNodeRuntimeState } from "../planning/readyNodeRuntime";
import type { ResultState } from "../resultValidity";

interface ReadyOperationCommit {
  readonly cell: GraphNodeCell;
  readonly node: object;
  readonly deps: Record<string, object>;
  readonly resultState: ResultState;
  readonly operationDisposers: ReadonlyArray<Disposer>;
}

export function commitReadyOperationResultSync(input: ReadyOperationCommit): void {
  const latest = input.cell.state.getSync();
  input.cell.state.updateSync((latest) => {
    commitReadyOperationState({
      latest,
      deps: input.deps,
      resultState: input.resultState,
      operationDisposers: input.operationDisposers,
    });
  });
  updateReadyNodeRuntimeState({
    node: input.node,
    args: phaseArgs(latest.phase),
    deps: input.deps,
    result: input.resultState.result,
    resultPatched: input.resultState.resultPatched,
  });
}

export function appendOperationDisposersSync(
  cell: GraphNodeCell,
  operationDisposers: ReadonlyArray<Disposer>
): void {
  if (operationDisposers.length === 0) return;
  cell.state.updateSync((latest) => {
    appendReadyDisposersState({ latest, operationDisposers });
  });
}
