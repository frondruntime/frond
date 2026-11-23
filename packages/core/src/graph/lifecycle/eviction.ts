import { Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import type { GraphPlanState } from "../cell/cellModel";
import type { GraphCellQueue } from "../cell/cellQueue";
import type {
  DriverOperationTimeouts,
  EvictResult,
  EvictSubgraphRequest,
  GraphFailure,
  NodeId,
} from "../types";
import { releaseCell } from "./cleanup";
import { type EvictionPlan, evictionPlan, removePlannedEdges } from "./evictionPlan";
import { type Restore, shutdownWithin, teardownPlan, unrestored } from "./teardownOrder";

export interface GraphEvictionEnvironment {
  readonly state: GraphPlanState;
  readonly queues: Map<NodeId, GraphCellQueue>;
  readonly getExistingQueue: (nodeId: NodeId) => GraphCellQueue | undefined;
  readonly clearRefreshAdmission: (nodeId: NodeId) => Effect.Effect<void>;
  readonly driverTimeouts: DriverOperationTimeouts;
}

export function evictSubgraph(
  env: GraphEvictionEnvironment,
  request: EvictSubgraphRequest
): Effect.Effect<EvictResult> {
  return Effect.uninterruptibleMask((restore) => evictInOrder(env, request, restore));
}

function evictInOrder(
  env: GraphEvictionEnvironment,
  request: EvictSubgraphRequest,
  restore: Restore
): Effect.Effect<EvictResult> {
  return Effect.gen(function* () {
    const plan = evictionPlan(env.state, request);
    const { nodeIds } = plan;
    const reason: RuntimeCancellationReason = request.cancellation ?? {
      _tag: "Evicted",
      detail: request.reason,
    };
    // Cleanup runs dependents first (before `evictNode` drops any edge), one
    // node at a time; the result keeps the reported `nodeIds` order.
    const { order } = teardownPlan(nodeIds, env.state.edges);
    const failuresByNode = new Array<ReadonlyArray<GraphFailure>>(nodeIds.length);
    const draining: Array<GraphCellQueue> = [];
    for (const index of order) {
      failuresByNode[index] = yield* evictNode(env, plan, index, reason, draining, restore);
    }
    // A drain that outlived its bound is still running: the eviction ends
    // only once every evicted cell's canceled work has drained.
    for (const queue of draining) {
      yield* queue.close(reason);
    }
    const failures: Array<GraphFailure> = [];
    for (const nodeFailures of failuresByNode) {
      for (const failure of nodeFailures) {
        failures.push(failure);
      }
    }

    return {
      nodeIds,
      failures,
    };
  });
}

function evictNode(
  env: GraphEvictionEnvironment,
  plan: EvictionPlan,
  index: number,
  reason: RuntimeCancellationReason,
  draining: Array<GraphCellQueue>,
  restore: Restore
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  return Effect.gen(function* () {
    const nodeId = plan.nodeIds[index] as NodeId;
    const cellLookup = lookupGraphNodeCell(env.state, nodeId);

    if (cellLookup._tag === "Missing") {
      return [];
    }

    const { cell } = cellLookup;
    const queue = env.getExistingQueue(nodeId);
    const cleanup = releaseCell(
      env.state,
      cell,
      env.driverTimeouts.release,
      env.driverTimeouts.live,
      { _tag: "NodeEvicted" }
    );
    // A cancel ends the eviction only while no drain has outlived its bound.
    // A drain that outlives it puts its queue in `draining` before its node's
    // cleanup starts; the queue leaves the registry below, so from then on the
    // eviction finishes every node and waits for the drain: stop and a
    // reacquire of the node, which need the gate, still come after it.
    const interruptible = draining.length === 0 ? restore : unrestored;
    const cleanupFailures =
      (yield* queue === undefined
        ? interruptible(cleanup)
        : shutdownWithin(
            queue,
            reason,
            cleanup,
            env.driverTimeouts.release,
            draining,
            interruptible
          )) ?? [];

    env.queues.delete(nodeId);
    yield* env.clearRefreshAdmission(nodeId);
    // Raise the floor past the evicted cell's revision so a recreated cell for
    // the same node id seeds past it, keeping `readVersion` monotonic across
    // incarnations.
    env.state.evictedRevisionFloor = Math.max(
      env.state.evictedRevisionFloor,
      cell.state.getRevisionSync()
    );
    env.state.nodes.delete(nodeId);
    removePlannedEdges(env.state.edges, plan, index);
    // A node can stay Found while its neighbor is gone: a "dependents"
    // eviction keeps its roots but may remove a node between two of them, and
    // an interrupted or failed eviction can stop partway through the set.
    // Un-wire every cell so the same-identity re-plan fast path re-plans each
    // once.
    env.state.wiringGeneration += 1;
    return cleanupFailures;
  });
}
