import type { EdgeSnapshot, EvictSubgraphRequest, NodeId } from "../types";

/** The parts of the plan state an eviction plan reads. */
export interface EvictionGraph {
  readonly nodes: ReadonlyMap<NodeId, unknown>;
  readonly edges: ReadonlyMap<string, EdgeSnapshot>;
}

/**
 * The nodes an eviction removes, in the reported order, and the key of every
 * edge that touches each of them, so a node's edges go without a scan of
 * every edge. The keys are read once, under the gate the eviction holds:
 * only planning writes edges, and it waits for that gate.
 */
export interface EvictionPlan {
  readonly nodeIds: ReadonlyArray<NodeId>;
  /** Node `index`'s edge keys: `edgeKeyStart[index]` up to `edgeKeyStart[index + 1]`. */
  readonly edgeKeyStart: Int32Array;
  readonly edgeKeys: ReadonlyArray<string>;
}

/**
 * Plans an eviction: the roots that exist, then every node that depends on a
 * root, directly or not, in breadth-first order over the edges in the order
 * planning recorded them; "dependents" mode drops the roots. The reported
 * order is by dependency depth, deepest first, ties in that order; cleanup
 * follows `teardownPlan` instead. A node's depth is the largest of its
 * shortest distances to the nodes that depend on it.
 *
 * Linear in nodes plus edges when every path between two nodes has the same
 * length (a chain, a fan-in, a layered lattice): each depth is then the
 * node's longest path to a node with no dependents. Otherwise, as when an
 * edge skips a layer, each reported node's depth takes its own breadth-first
 * pass, as before; a retained root takes none.
 */
export function evictionPlan(
  graph: EvictionGraph,
  request: Pick<EvictSubgraphRequest, "rootNodeIds" | "mode">
): EvictionPlan {
  const indexed = indexGraph(graph, request.rootNodeIds);
  const dependents = dependentLists(indexed);
  const closure = dependentClosure(graph, request.rootNodeIds, indexed, dependents);

  // "dependents" mode reports and evicts every node but the roots. The depth
  // passes start only from reported nodes, but still cross the roots.
  if (request.mode === "dependents") {
    for (const root of indexed.rootIndexes) {
      closure.inClosure[root] = 0;
    }
  }

  // One reported node or none needs no depths to be in order.
  const depth =
    reportedCount(closure) <= 1
      ? undefined
      : (longestPathDepths(closure, dependents) ?? shortestPathDepths(closure, dependents));
  const order = orderByDepth(closure, depth, indexed.ids);
  const { edgeKeyStart, edgeKeys } = plannedEdgeKeys(graph, indexed, order);
  return { nodeIds: order.nodeIds, edgeKeyStart, edgeKeys };
}

/** Deletes every edge that touched `plan.nodeIds[index]` when it was planned. */
export function removePlannedEdges(
  edges: Map<string, EdgeSnapshot>,
  plan: EvictionPlan,
  index: number
): void {
  const end = plan.edgeKeyStart[index + 1] as number;
  for (let slot = plan.edgeKeyStart[index] as number; slot < end; slot += 1) {
    edges.delete(plan.edgeKeys[slot] as string);
  }
}

/** Every node an edge or a root names, by index; edges as index pairs in map order. */
interface IndexedGraph {
  readonly ids: ReadonlyArray<NodeId>;
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly rootIndexes: Int32Array;
}

function indexGraph(graph: EvictionGraph, roots: ReadonlyArray<NodeId>): IndexedGraph {
  const indexById = new Map<NodeId, number>();
  const ids: Array<NodeId> = [];
  const edgeFrom = new Int32Array(graph.edges.size);
  const edgeTo = new Int32Array(graph.edges.size);
  let edge = 0;
  for (const { from, to } of graph.edges.values()) {
    edgeFrom[edge] = nodeIndex(indexById, ids, from);
    edgeTo[edge] = nodeIndex(indexById, ids, to);
    edge += 1;
  }
  const rootIndexes = new Int32Array(roots.length);
  for (let root = 0; root < roots.length; root += 1) {
    rootIndexes[root] = nodeIndex(indexById, ids, roots[root] as NodeId);
  }
  return { ids, edgeFrom, edgeTo, rootIndexes };
}

function nodeIndex(indexById: Map<NodeId, number>, ids: Array<NodeId>, nodeId: NodeId): number {
  const known = indexById.get(nodeId);
  if (known !== undefined) {
    return known;
  }
  const index = ids.length;
  indexById.set(nodeId, index);
  ids.push(nodeId);
  return index;
}

/**
 * Each node's dependents, one per edge, in edge order:
 * `start[node]` up to `start[node + 1]` in `list`.
 */
interface DependentLists {
  readonly start: Int32Array;
  readonly list: Int32Array;
}

function dependentLists(indexed: IndexedGraph): DependentLists {
  const count = indexed.ids.length;
  const { edgeFrom, edgeTo } = indexed;
  const start = new Int32Array(count + 1);
  for (let edge = 0; edge < edgeTo.length; edge += 1) {
    const to = edgeTo[edge] as number;
    start[to + 1] = (start[to + 1] as number) + 1;
  }
  for (let node = 0; node < count; node += 1) {
    start[node + 1] = (start[node + 1] as number) + (start[node] as number);
  }
  const list = new Int32Array(edgeTo.length);
  const cursor = start.slice(0, count);
  for (let edge = 0; edge < edgeTo.length; edge += 1) {
    const to = edgeTo[edge] as number;
    const slot = cursor[to] as number;
    list[slot] = edgeFrom[edge] as number;
    cursor[to] = slot + 1;
  }
  return { start, list };
}

/**
 * The roots that exist, then each dependent the first time a breadth-first
 * pass from every root, existing or not, reaches it: `nodes` up to `size`.
 * It holds every node its nodes' dependents reach. `inClosure` marks the
 * nodes the eviction reports once "dependents" mode has cleared the roots.
 * `queue` holds at least every node, for the depth passes to reuse.
 */
interface Closure {
  readonly nodes: Int32Array;
  readonly size: number;
  readonly inClosure: Uint8Array;
  readonly queue: Int32Array;
}

function dependentClosure(
  graph: EvictionGraph,
  roots: ReadonlyArray<NodeId>,
  indexed: IndexedGraph,
  dependents: DependentLists
): Closure {
  const count = indexed.ids.length;
  const inClosure = new Uint8Array(count);
  const nodes = new Int32Array(count);
  let size = 0;
  const queue = new Int32Array(roots.length + count);
  let tail = 0;
  for (let root = 0; root < roots.length; root += 1) {
    const node = indexed.rootIndexes[root] as number;
    queue[tail] = node;
    tail += 1;
    if (inClosure[node] === 0 && graph.nodes.has(roots[root] as NodeId)) {
      inClosure[node] = 1;
      nodes[size] = node;
      size += 1;
    }
  }
  for (let head = 0; head < tail; head += 1) {
    const node = queue[head] as number;
    const end = dependents.start[node + 1] as number;
    for (let slot = dependents.start[node] as number; slot < end; slot += 1) {
      const dependent = dependents.list[slot] as number;
      if (inClosure[dependent] === 0) {
        inClosure[dependent] = 1;
        nodes[size] = dependent;
        size += 1;
        queue[tail] = dependent;
        tail += 1;
      }
    }
  }
  return { nodes, size, inClosure, queue };
}

function reportedCount(closure: Closure): number {
  let count = 0;
  for (let position = 0; position < closure.size; position += 1) {
    count += closure.inClosure[closure.nodes[position] as number] as number;
  }
  return count;
}

/**
 * Each reported node's longest path to a node with no dependents, by one
 * depth-first pass over the dependents. When every dependent edge it reaches
 * drops exactly one level, every path between two nodes has the same length,
 * so this is also the largest shortest distance; when one does not, or on a
 * cycle it reaches, returns undefined.
 */
function longestPathDepths(closure: Closure, dependents: DependentLists): Int32Array | undefined {
  const { start, list } = dependents;
  const count = start.length - 1;
  const depth = new Int32Array(count);
  // 0: not reached; 1: on the stack; 2: done.
  const mark = new Uint8Array(count);
  const stack = new Int32Array(count);
  const next = new Int32Array(count);
  for (let position = 0; position < closure.size; position += 1) {
    const first = closure.nodes[position] as number;
    if (closure.inClosure[first] === 0 || mark[first] !== 0) {
      continue;
    }
    mark[first] = 1;
    next[first] = start[first] as number;
    stack[0] = first;
    let top = 1;
    while (top > 0) {
      const node = stack[top - 1] as number;
      const slot = next[node] as number;
      const end = start[node + 1] as number;
      if (slot < end) {
        next[node] = slot + 1;
        const dependent = list[slot] as number;
        switch (mark[dependent]) {
          case 0:
            mark[dependent] = 1;
            next[dependent] = start[dependent] as number;
            stack[top] = dependent;
            top += 1;
            break;
          case 1:
            return undefined;
          default:
            break;
        }
        continue;
      }
      // Every dependent is done: one level past the deepest, and no lower.
      let nodeDepth = 0;
      for (let edge = start[node] as number; edge < end; edge += 1) {
        nodeDepth = Math.max(nodeDepth, (depth[list[edge] as number] as number) + 1);
      }
      for (let edge = start[node] as number; edge < end; edge += 1) {
        if ((depth[list[edge] as number] as number) + 1 !== nodeDepth) {
          return undefined;
        }
      }
      depth[node] = nodeDepth;
      mark[node] = 2;
      top -= 1;
    }
  }
  return depth;
}

/**
 * Each reported node's largest shortest distance to a node that depends on
 * it, one breadth-first pass per node over reused arrays.
 */
function shortestPathDepths(closure: Closure, dependents: DependentLists): Int32Array {
  const { start, list } = dependents;
  const { queue } = closure;
  const count = start.length - 1;
  const depth = new Int32Array(count);
  const distance = new Int32Array(count);
  // `seen[node] === pass`: this pass reached the node.
  const seen = new Int32Array(count);
  for (let position = 0; position < closure.size; position += 1) {
    const first = closure.nodes[position] as number;
    if (closure.inClosure[first] === 0) {
      continue;
    }
    const pass = position + 1;
    seen[first] = pass;
    distance[first] = 0;
    queue[0] = first;
    let tail = 1;
    for (let head = 0; head < tail; head += 1) {
      const node = queue[head] as number;
      const nextDistance = (distance[node] as number) + 1;
      const end = start[node + 1] as number;
      for (let slot = start[node] as number; slot < end; slot += 1) {
        const dependent = list[slot] as number;
        if (seen[dependent] !== pass) {
          seen[dependent] = pass;
          distance[dependent] = nextDistance;
          queue[tail] = dependent;
          tail += 1;
        }
      }
    }
    // Breadth-first: the last node reached is the farthest.
    depth[first] = distance[queue[tail - 1] as number] as number;
  }
  return depth;
}

/** The evicted nodes, deepest first, and each one's position, or -1. */
interface DepthOrder {
  readonly nodeIds: ReadonlyArray<NodeId>;
  readonly position: Int32Array;
}

/**
 * A stable counting sort of the reported nodes, deepest first; without
 * depths, in closure order.
 */
function orderByDepth(
  closure: Closure,
  depth: Int32Array | undefined,
  ids: ReadonlyArray<NodeId>
): DepthOrder {
  const { nodes, inClosure } = closure;
  const depthOf = (node: number): number => (depth === undefined ? 0 : (depth[node] as number));
  let maxDepth = 0;
  for (let index = 0; index < closure.size; index += 1) {
    const node = nodes[index] as number;
    if (inClosure[node] === 1) {
      maxDepth = Math.max(maxDepth, depthOf(node));
    }
  }
  // Bucket `maxDepth - depth` starts at `bucketStart[bucket]`.
  const bucketStart = new Int32Array(maxDepth + 2);
  let evicted = 0;
  for (let index = 0; index < closure.size; index += 1) {
    const node = nodes[index] as number;
    if (inClosure[node] === 1) {
      const bucket = maxDepth - depthOf(node) + 1;
      bucketStart[bucket] = (bucketStart[bucket] as number) + 1;
      evicted += 1;
    }
  }
  for (let bucket = 1; bucket <= maxDepth + 1; bucket += 1) {
    bucketStart[bucket] = (bucketStart[bucket] as number) + (bucketStart[bucket - 1] as number);
  }
  const nodeIds = new Array<NodeId>(evicted);
  const position = new Int32Array(ids.length).fill(-1);
  for (let index = 0; index < closure.size; index += 1) {
    const node = nodes[index] as number;
    if (inClosure[node] === 1) {
      const bucket = maxDepth - depthOf(node);
      const target = bucketStart[bucket] as number;
      bucketStart[bucket] = target + 1;
      nodeIds[target] = ids[node] as NodeId;
      position[node] = target;
    }
  }
  return { nodeIds, position };
}

/**
 * Each evicted node's edge keys, both ends: an edge between two evicted
 * nodes is listed under each, and its second delete finds nothing.
 */
function plannedEdgeKeys(
  graph: EvictionGraph,
  indexed: IndexedGraph,
  order: DepthOrder
): Pick<EvictionPlan, "edgeKeyStart" | "edgeKeys"> {
  const { edgeFrom, edgeTo } = indexed;
  const { position } = order;
  const evicted = order.nodeIds.length;
  const edgeKeyStart = new Int32Array(evicted + 1);
  for (let edge = 0; edge < edgeFrom.length; edge += 1) {
    const from = position[edgeFrom[edge] as number] as number;
    const to = position[edgeTo[edge] as number] as number;
    if (from >= 0) {
      edgeKeyStart[from + 1] = (edgeKeyStart[from + 1] as number) + 1;
    }
    if (to >= 0 && to !== from) {
      edgeKeyStart[to + 1] = (edgeKeyStart[to + 1] as number) + 1;
    }
  }
  for (let index = 0; index < evicted; index += 1) {
    edgeKeyStart[index + 1] = (edgeKeyStart[index + 1] as number) + (edgeKeyStart[index] as number);
  }
  const edgeKeys = new Array<string>(edgeKeyStart[evicted] as number);
  const cursor = edgeKeyStart.slice(0, evicted);
  let edge = 0;
  for (const edgeKey of graph.edges.keys()) {
    const from = position[edgeFrom[edge] as number] as number;
    const to = position[edgeTo[edge] as number] as number;
    if (from >= 0) {
      const slot = cursor[from] as number;
      edgeKeys[slot] = edgeKey;
      cursor[from] = slot + 1;
    }
    if (to >= 0 && to !== from) {
      const slot = cursor[to] as number;
      edgeKeys[slot] = edgeKey;
      cursor[to] = slot + 1;
    }
    edge += 1;
  }
  return { edgeKeyStart, edgeKeys };
}
