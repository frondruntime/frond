import { Effect } from "effect";
import type { GraphNodeCell } from "../planning/plan";
import type { NodeId } from "../types";
import { type GraphCellActor, makeGraphCellActor } from "./cellActor";

export interface GraphCellActorRegistry {
  readonly actors: Map<NodeId, GraphCellActor>;
  readonly getActor: (cell: GraphNodeCell) => Effect.Effect<GraphCellActor>;
  readonly getExistingActor: (nodeId: NodeId) => Effect.Effect<GraphCellActor | undefined>;
  readonly shutdownActors: <A>(
    cleanup: (nodeId: NodeId, actor: GraphCellActor) => Effect.Effect<A>
  ) => Effect.Effect<ReadonlyArray<A>>;
}

export function makeGraphCellActorRegistry(): GraphCellActorRegistry {
  const actors = new Map<NodeId, GraphCellActor>();

  // Hazard: actor creation relies on the graph system planning semaphore for
  // serialization. Do not call getActor from an unguarded path or this plain
  // get-or-create map can race for the same nodeId.
  const getActor = (cell: GraphNodeCell): Effect.Effect<GraphCellActor> =>
    Effect.gen(function* () {
      const existing = actors.get(cell.nodeId);

      if (existing !== undefined) {
        return existing;
      }

      const actor = yield* makeGraphCellActor();
      actors.set(cell.nodeId, actor);
      return actor;
    });

  const getExistingActor = (nodeId: NodeId): Effect.Effect<GraphCellActor | undefined> =>
    Effect.sync(() => actors.get(nodeId));

  const shutdownActors = <A>(
    cleanup: (nodeId: NodeId, actor: GraphCellActor) => Effect.Effect<A>
  ): Effect.Effect<ReadonlyArray<A>> =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        [...actors.entries()],
        ([nodeId, actor]) => cleanup(nodeId, actor),
        {
          concurrency: "unbounded",
        }
      );
      actors.clear();
      return results;
    });

  return {
    actors,
    getActor,
    getExistingActor,
    shutdownActors,
  };
}
