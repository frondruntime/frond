import { Effect, Match, Semaphore } from "effect";
import type { NodeId } from "../types";
import type { GraphCellOperation, GraphCellTask } from "./cellActor";
import { lookupGraphNodeCell } from "./cellLookup";
import type { GraphNodeCell, GraphPlanState } from "./cellModel";

export type CellSubmission<A> =
  | {
      readonly _tag: "Submitted";
      readonly task: GraphCellTask<A>;
    }
  | {
      readonly _tag: "Missing";
      readonly nodeId: NodeId;
    };

export function submitToCellActor<A>(
  options: {
    readonly state: GraphPlanState;
    readonly planningSemaphore: ReturnType<typeof Semaphore.makeUnsafe>;
    readonly submit: <A>(
      cell: GraphNodeCell,
      operation: GraphCellOperation<A>
    ) => Effect.Effect<GraphCellTask<A>>;
  },
  nodeId: NodeId,
  operation: (cell: GraphNodeCell) => GraphCellOperation<A>
): Effect.Effect<CellSubmission<A>> {
  return Semaphore.withPermit(
    options.planningSemaphore,
    Match.value(lookupGraphNodeCell(options.state, nodeId)).pipe(
      Match.tag("Missing", ({ nodeId }) => Effect.succeed({ _tag: "Missing", nodeId } as const)),
      Match.tag("Found", ({ cell }) =>
        Effect.gen(function* () {
          const task = yield* options.submit(cell, operation(cell));
          return { _tag: "Submitted", task } as const;
        })
      ),
      Match.exhaustive
    )
  );
}
