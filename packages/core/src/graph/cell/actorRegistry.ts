import { Deferred, Effect } from "effect";
import type { NodeId } from "../types";
import {
  type GraphCellActor,
  type GraphCellOperation,
  type GraphCellSubmitOptions,
  type GraphCellTask,
  makeGraphCellActor,
} from "./cellActor";
import type { GraphNodeCell } from "./cellModel";

export interface GraphCellActorRegistry {
  readonly actors: Map<NodeId, GraphCellActor>;
  readonly submit: <A>(
    cell: GraphNodeCell,
    operation: GraphCellOperation<A>,
    options?: GraphCellSubmitOptions | undefined
  ) => Effect.Effect<GraphCellTask<A>>;
  readonly getExistingActor: (nodeId: NodeId) => Effect.Effect<GraphCellActor | undefined>;
  readonly deleteActor: (nodeId: NodeId, actor?: GraphCellActor | undefined) => Effect.Effect<void>;
  readonly closeForShutdown: () => Effect.Effect<ReadonlyArray<readonly [NodeId, GraphCellActor]>>;
}

export function makeGraphCellActorRegistry(): GraphCellActorRegistry {
  const actors = new Map<NodeId, GraphCellActor>();
  let closed = false;

  // Hazard: actor creation relies on the graph system planning semaphore for
  // serialization. Do not call submit from an unguarded path or this plain
  // get-or-create map can race for the same nodeId.
  const submit = <A>(
    cell: GraphNodeCell,
    operation: GraphCellOperation<A>,
    options?: GraphCellSubmitOptions | undefined
  ): Effect.Effect<GraphCellTask<A>> =>
    Effect.gen(function* () {
      if (closed) {
        return yield* closedCellTask(operation, options);
      }

      const existing = actors.get(cell.nodeId);

      if (existing !== undefined) {
        return yield* existing.submit(operation, options);
      }

      const actor = yield* makeGraphCellActor();
      actors.set(cell.nodeId, actor);
      return yield* actor.submit(operation, options);
    });

  const getExistingActor = (nodeId: NodeId): Effect.Effect<GraphCellActor | undefined> =>
    Effect.sync(() => actors.get(nodeId));

  const deleteActor = (nodeId: NodeId, actor?: GraphCellActor | undefined): Effect.Effect<void> =>
    Effect.sync(() => {
      if (actor !== undefined && actors.get(nodeId) !== actor) {
        return;
      }

      actors.delete(nodeId);
    });

  const closeForShutdown = (): Effect.Effect<ReadonlyArray<readonly [NodeId, GraphCellActor]>> =>
    Effect.sync(() => {
      closed = true;
      const snapshot = [...actors.entries()];
      actors.clear();
      return snapshot;
    });

  return {
    actors,
    submit,
    getExistingActor,
    deleteActor,
    closeForShutdown,
  };
}

function closedCellTask<A>(
  operation: GraphCellOperation<A>,
  options?: GraphCellSubmitOptions | undefined
): Effect.Effect<GraphCellTask<A>> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const reply = yield* Deferred.make<A>();
      yield* operation.interrupt(reply, {
        _tag: "Released",
        detail: "graph cell is closed",
      });
      yield* Effect.sync(() => {
        options?.onComplete?.();
      }).pipe(Effect.catchCause(() => Effect.void));
      return { await: Deferred.await(reply) };
    })
  );
}
