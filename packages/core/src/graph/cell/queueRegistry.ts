import type { Context } from "effect";
import type { GraphJobQueue } from "../queue/jobQueue";
import type { NodeId } from "../types";
import type { GraphNodeCell } from "./cellModel";
import {
  type GraphCellOperation,
  GraphCellQueue,
  type GraphCellSubmitOptions,
  type GraphCellTask,
} from "./cellQueue";

export function makeGraphCellQueueRegistry(jobs: GraphJobQueue) {
  const queues = new Map<NodeId, GraphCellQueue>();
  let closed = false;
  const submitSync = <A>(
    cell: GraphNodeCell,
    operation: GraphCellOperation<A>,
    context: Context.Context<never> | undefined,
    options?: GraphCellSubmitOptions
  ): GraphCellTask<A> => {
    let queue = queues.get(cell.nodeId);
    if (queue === undefined) {
      queue = new GraphCellQueue(
        jobs,
        closed ? { _tag: "Released", detail: "graph cell is closed" } : undefined
      );
      if (!closed) queues.set(cell.nodeId, queue);
    }
    return queue.submitSync(operation, context, options);
  };
  return {
    queues,
    submitSync,
    getExistingQueue: (nodeId: NodeId) => queues.get(nodeId),
    deleteQueue: (nodeId: NodeId, queue?: GraphCellQueue) => {
      if (queue === undefined || queues.get(nodeId) === queue) queues.delete(nodeId);
    },
    closeForShutdown: () => {
      closed = true;
      const snapshot = [...queues.entries()];
      queues.clear();
      return snapshot;
    },
  };
}

export type GraphCellQueueRegistry = ReturnType<typeof makeGraphCellQueueRegistry>;
