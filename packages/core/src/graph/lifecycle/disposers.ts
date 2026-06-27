import { Effect } from "effect";
import type { GraphNodeCell } from "../planning/plan";
import { DisposerFailed } from "../types";

export function runDisposers(
  cell: GraphNodeCell,
  disposers: ReadonlyArray<() => void>
): Effect.Effect<ReadonlyArray<DisposerFailed>> {
  return Effect.forEach(
    [...disposers].reverse(),
    (disposer) =>
      Effect.try({
        try: disposer,
        catch: (cause) => new DisposerFailed({ nodeId: cell.nodeId, tag: cell.tag, cause }),
      }).pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => undefined,
        })
      ),
    {
      concurrency: 1,
    }
  ).pipe(Effect.map((failures) => failures.filter((failure) => failure !== undefined)));
}
