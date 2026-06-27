import { Effect } from "effect";
import type { GraphCellActor } from "../cell/cellActor";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import type { GraphPlanState } from "../planning/plan";
import type {
  DriverOperationTimeouts,
  EvictResult,
  EvictSubgraphRequest,
  GraphFailure,
  NodeId,
} from "../types";
import { releaseCell } from "./cleanup";

export interface GraphEvictionEnvironment {
  readonly state: GraphPlanState;
  readonly actors: Map<NodeId, GraphCellActor>;
  readonly getExistingActor: (nodeId: NodeId) => Effect.Effect<GraphCellActor | undefined>;
  readonly driverTimeouts: DriverOperationTimeouts;
}

export function evictSubgraph(
  env: GraphEvictionEnvironment,
  request: EvictSubgraphRequest
): Effect.Effect<EvictResult> {
  return Effect.gen(function* () {
    const nodeIds = evictedNodeIds(env.state, request);
    const failures = yield* Effect.forEach(nodeIds, (nodeId) => evictNode(env, nodeId, request), {
      concurrency: 1,
    });

    return {
      nodeIds,
      failures: failures.flat(),
    };
  });
}

function evictNode(
  env: GraphEvictionEnvironment,
  nodeId: NodeId,
  request: EvictSubgraphRequest
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  return Effect.gen(function* () {
    const cellLookup = lookupGraphNodeCell(env.state, nodeId);

    if (cellLookup._tag === "Missing") {
      return [];
    }

    const { cell } = cellLookup;
    const actor = yield* env.getExistingActor(nodeId);
    const cleanupFailures =
      actor === undefined
        ? yield* releaseCell(cell, env.driverTimeouts.release, env.driverTimeouts.live, {
            _tag: "NodeEvicted",
          })
        : ((yield* actor.shutdown({
            reason: request.cancellation ?? { _tag: "Evicted", detail: request.reason },
            cleanup: releaseCell(cell, env.driverTimeouts.release, env.driverTimeouts.live, {
              _tag: "NodeEvicted",
            }),
          })) ?? []);

    env.actors.delete(nodeId);
    env.state.nodes.delete(nodeId);
    removeEdgesForNode(env.state, nodeId);
    return cleanupFailures;
  });
}

function evictedNodeIds(
  state: GraphPlanState,
  request: EvictSubgraphRequest
): ReadonlyArray<NodeId> {
  const reverseEdges = reverseAdjacency(state);
  const closure = reverseDependencyClosure(state, reverseEdges, request.rootNodeIds);

  if (request.mode === "dependents") {
    for (const rootNodeId of request.rootNodeIds) {
      closure.delete(rootNodeId);
    }
  }

  // Memoize depth once per node, then sort by lookup. Computing depth inside the
  // comparator re-ran a full BFS O(n log n) times; this keeps the order identical
  // (same depths, same input order for ties) while doing O(n) BFS passes.
  const depthByNode = new Map<NodeId, number>();
  for (const nodeId of closure) {
    depthByNode.set(nodeId, dependencyDepth(reverseEdges, nodeId));
  }

  return [...closure].sort(
    (left, right) => (depthByNode.get(right) ?? 0) - (depthByNode.get(left) ?? 0)
  );
}

function reverseAdjacency(state: GraphPlanState): ReadonlyMap<NodeId, ReadonlyArray<NodeId>> {
  const reverseEdges = new Map<NodeId, Array<NodeId>>();

  for (const edge of state.edges.values()) {
    const dependents = reverseEdges.get(edge.to) ?? [];
    dependents.push(edge.from);
    reverseEdges.set(edge.to, dependents);
  }

  return reverseEdges;
}

function reverseDependencyClosure(
  state: GraphPlanState,
  reverseEdges: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>,
  roots: ReadonlyArray<NodeId>
): Set<NodeId> {
  const visited = new Set<NodeId>();
  const queue = [...roots];
  let head = 0;

  for (const root of roots) {
    if (state.nodes.has(root)) {
      visited.add(root);
    }
  }

  while (head < queue.length) {
    const current = queue[head];
    head += 1;

    if (current === undefined) {
      continue;
    }

    for (const dependent of reverseEdges.get(current) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return visited;
}

function dependencyDepth(
  reverseEdges: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>,
  nodeId: NodeId
): number {
  let depth = 0;
  const visited = new Set<NodeId>();
  const queue: Array<{ readonly nodeId: NodeId; readonly depth: number }> = [{ nodeId, depth: 0 }];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;

    if (current === undefined) {
      continue;
    }

    if (visited.has(current.nodeId)) {
      continue;
    }

    visited.add(current.nodeId);
    depth = Math.max(depth, current.depth);

    for (const dependent of reverseEdges.get(current.nodeId) ?? []) {
      queue.push({ nodeId: dependent, depth: current.depth + 1 });
    }
  }

  return depth;
}

function removeEdgesForNode(state: GraphPlanState, nodeId: NodeId): void {
  for (const [edgeKey, edge] of state.edges) {
    if (edge.from === nodeId || edge.to === nodeId) {
      state.edges.delete(edgeKey);
    }
  }
}
