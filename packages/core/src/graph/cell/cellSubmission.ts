import { Effect, Match, Semaphore } from "effect";
import type { GraphNodeCell, GraphPlanState } from "../planning/plan";
import type { NodeId } from "../types";
import type { GraphCellActor, GraphCellTask } from "./cellActor";
import { lookupGraphNodeCell } from "./cellLookup";

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
    readonly getActor: (cell: GraphNodeCell) => Effect.Effect<GraphCellActor>;
  },
  nodeId: NodeId,
  submit: (cell: GraphNodeCell, actor: GraphCellActor) => Effect.Effect<GraphCellTask<A>>
): Effect.Effect<CellSubmission<A>> {
  return Semaphore.withPermit(
    options.planningSemaphore,
    Match.value(lookupGraphNodeCell(options.state, nodeId)).pipe(
      Match.tag("Missing", ({ nodeId }) => Effect.succeed({ _tag: "Missing", nodeId } as const)),
      Match.tag("Found", ({ cell }) =>
        Effect.gen(function* () {
          const actor = yield* options.getActor(cell);
          const task = yield* submit(cell, actor);
          return { _tag: "Submitted", task } as const;
        })
      ),
      Match.exhaustive
    )
  );
}
