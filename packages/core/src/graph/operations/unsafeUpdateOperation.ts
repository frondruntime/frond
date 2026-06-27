import { Effect } from "effect";
import { mapPhaseReady, phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import type { GraphNodeCell } from "../planning/plan";
import { updateReadyNodeRuntimeState } from "../planning/readyNodeRuntime";
import type { UnsafeUpdateNodeRequest, UnsafeUpdateNodeResult } from "../types";
import { makeUnsafeUpdateNodeFailure } from "./operationFailures";

export function unsafeUpdateNodeInCell(
  cell: GraphNodeCell,
  request: UnsafeUpdateNodeRequest
): Effect.Effect<UnsafeUpdateNodeResult> {
  return Effect.gen(function* () {
    const current = yield* cell.state.get;
    const projection = projectCellPhase(current.phase);
    const readyLookup = phaseReadyData(current.phase);

    if (
      projection._tag === "Removed" ||
      projection.status._tag !== "Wired" ||
      readyLookup._tag === "Missing"
    ) {
      return makeUnsafeUpdateNodeFailure(
        cell,
        request,
        projection._tag === "Removed" ? { _tag: "Unwired" } : projection.status
      );
    }

    const { node } = readyLookup.ready;

    return yield* Effect.sync(() => {
      try {
        request.recipe(node);
        const result = (node as { readonly result?: unknown }).result;
        return {
          _tag: "Success",
          nodeId: cell.nodeId,
          value: result,
        } satisfies UnsafeUpdateNodeResult;
      } catch (cause) {
        return makeUnsafeUpdateNodeFailure(cell, request, cause);
      }
    }).pipe(
      Effect.tap((result) =>
        result._tag === "Success"
          ? cell.state
              .transition((latest) => [
                undefined,
                {
                  ...latest,
                  phase: mapPhaseReady(latest.phase, (readyData) => ({
                    ...readyData,
                    result: result.value,
                  })),
                },
              ])
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    updateReadyNodeRuntimeState({
                      node,
                      result: result.value,
                    });
                  })
                ),
                Effect.tap(() => cell.notifyChanged(cell.nodeId))
              )
          : Effect.void
      )
    );
  });
}
