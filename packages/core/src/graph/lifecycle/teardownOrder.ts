import { Deferred, Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type { GraphCellQueue } from "../cell/cellQueue";
import type { DriverOperationTimeoutMs, EdgeSnapshot, GraphFailure, NodeId } from "../types";

/**
 * The teardown order of a set of nodes: dependents first, in true dependency
 * order. Every number is an index into the `nodeIds` the plan was built from.
 */
export interface TeardownPlan {
  /**
   * Every node once, each after all of its dependents in the set. The first
   * `placed` follow the edges; the rest are nodes a cycle left over.
   */
  readonly order: Int32Array;
  readonly placed: number;
  /** Each node's dependents in the set, one per edge. */
  readonly dependents: Int32Array;
  /**
   * Each node's dependencies in the set, contiguous: `dependencyStart[node]`
   * up to `dependencyStart[node + 1]` in `dependencyList`.
   */
  readonly dependencyStart: Int32Array;
  readonly dependencyList: Int32Array;
}

/**
 * Plans the teardown of `nodeIds` with Kahn's algorithm over the edges
 * (dependent -> dependency) with both ends in the set: an edge to or from a
 * node outside the set never blocks the order. Each edge counts once, so two
 * dependency slots naming the same node are two edges. Nodes with no
 * dependent come first in the order of `nodeIds`; a later node comes when its
 * last dependent is placed. Runs once per eviction or stop.
 */
export function teardownPlan(
  nodeIds: ReadonlyArray<NodeId>,
  edges: ReadonlyMap<string, EdgeSnapshot>
): TeardownPlan {
  const count = nodeIds.length;
  const indexById = new Map<NodeId, number>();
  for (let index = 0; index < count; index += 1) {
    indexById.set(nodeIds[index] as NodeId, index);
  }

  // In-set edges as (dependent, dependency) index pairs, plus each node's
  // dependent count and dependency count.
  const pairFrom = new Int32Array(edges.size);
  const pairTo = new Int32Array(edges.size);
  const dependents = new Int32Array(count);
  const dependencyStart = new Int32Array(count + 1);
  let pairs = 0;
  for (const edge of edges.values()) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    pairFrom[pairs] = from;
    pairTo[pairs] = to;
    pairs += 1;
    dependents[to] = (dependents[to] as number) + 1;
    dependencyStart[from + 1] = (dependencyStart[from + 1] as number) + 1;
  }

  for (let index = 0; index < count; index += 1) {
    dependencyStart[index + 1] =
      (dependencyStart[index + 1] as number) + (dependencyStart[index] as number);
  }
  const cursor = dependencyStart.slice(0, count);
  const dependencyList = new Int32Array(pairs);
  for (let pair = 0; pair < pairs; pair += 1) {
    const from = pairFrom[pair] as number;
    const slot = cursor[from] as number;
    dependencyList[slot] = pairTo[pair] as number;
    cursor[from] = slot + 1;
  }

  // `order` is the queue; `remaining` counts each node's unplaced dependents.
  const order = new Int32Array(count);
  const remaining = dependents.slice();
  let tail = 0;
  for (let index = 0; index < count; index += 1) {
    if (remaining[index] === 0) {
      order[tail] = index;
      tail += 1;
    }
  }
  for (let head = 0; head < tail; head += 1) {
    const node = order[head] as number;
    const end = dependencyStart[node + 1] as number;
    for (let slot = dependencyStart[node] as number; slot < end; slot += 1) {
      const dependency = dependencyList[slot] as number;
      const left = (remaining[dependency] as number) - 1;
      remaining[dependency] = left;
      if (left === 0) {
        order[tail] = dependency;
        tail += 1;
      }
    }
  }

  // Planning rejects cycles, so every node should be placed. If one is not,
  // the nodes left over still tear down rather than hang: last, after every
  // placed node, in the order of `nodeIds`, as before this ordering existed.
  const placed = tail;
  for (let index = 0; index < count && tail < count; index += 1) {
    if ((remaining[index] as number) > 0) {
      order[tail] = index;
      tail += 1;
    }
  }

  return { order, placed, dependents, dependencyStart, dependencyList };
}

/**
 * Runs `run` once per node of `plan`, concurrently, except that a node starts
 * only when all of its dependents in the set have finished. Nodes a cycle
 * left over start together once every placed node has finished. Results come
 * back by node index.
 */
export function runDependentsFirst<A>(
  plan: TeardownPlan,
  run: (index: number) => Effect.Effect<A>
): Effect.Effect<ReadonlyArray<A>> {
  return Effect.suspend(() => {
    const { order, placed, dependencyStart, dependencyList } = plan;
    const count = order.length;
    const waiting = plan.dependents.slice();
    const leftover = new Uint8Array(count);
    for (let position = placed; position < count; position += 1) {
      leftover[order[position] as number] = 1;
    }
    const indexes = new Array<number>(count);
    const starts = new Array<Deferred.Deferred<void>>(count);
    for (let index = 0; index < count; index += 1) {
      indexes[index] = index;
      starts[index] = Deferred.makeUnsafe<void>();
    }
    const start = (index: number): void => {
      Deferred.doneUnsafe(starts[index] as Deferred.Deferred<void>, Effect.void);
    };
    const startLeftovers = (): void => {
      for (let position = placed; position < count; position += 1) {
        start(order[position] as number);
      }
    };
    let placedRunning = placed;
    const finish = (index: number): void => {
      const end = dependencyStart[index + 1] as number;
      for (let slot = dependencyStart[index] as number; slot < end; slot += 1) {
        const dependency = dependencyList[slot] as number;
        const left = (waiting[dependency] as number) - 1;
        waiting[dependency] = left;
        if (left === 0 && leftover[dependency] === 0) start(dependency);
      }
      if (leftover[index] === 0) {
        placedRunning -= 1;
        if (placedRunning === 0) startLeftovers();
      }
    };
    for (let position = 0; position < placed; position += 1) {
      const index = order[position] as number;
      if (waiting[index] === 0) start(index);
    }
    if (placed === 0) startLeftovers();
    const step = (index: number): Effect.Effect<A> =>
      Deferred.await(starts[index] as Deferred.Deferred<void>).pipe(
        Effect.andThen(() => run(index)),
        Effect.map((result) => {
          finish(index);
          return result;
        })
      );
    return Effect.forEach(indexes, step, { concurrency: "unbounded" });
  });
}

/**
 * Marks the part of a shutdown a cancel may interrupt: the `restore` of an
 * uninterruptible region, or `unrestored` to leave it all uninterruptible.
 */
export type Restore = <A>(effect: Effect.Effect<A>) => Effect.Effect<A>;
export const unrestored: Restore = (effect) => effect;

/**
 * Shuts one cell down during a dependents-first teardown (stop or eviction).
 * An idle cell runs its cleanup through its queue at once. A cell still
 * draining canceled work waits for the drain at most `timeout`, the release
 * bound: past it, the cleanup runs outside the queue, whose FIFO the draining
 * entry still holds, so a finalizer that waits for a dependency's teardown
 * cannot hold that teardown back forever. The drain keeps running, and the
 * caller awaits it once the whole set is torn down; a late completion finds
 * the cell released and is refused. The expired wait reports no failure;
 * it adds the queue to `late`, when given, before the cleanup starts.
 * `restore` covers the wait and a shutdown through the queue, never the
 * cleanup after an expired wait.
 */
export function shutdownWithin(
  queue: GraphCellQueue,
  reason: RuntimeCancellationReason,
  cleanup: Effect.Effect<ReadonlyArray<GraphFailure>>,
  timeout: DriverOperationTimeoutMs,
  late?: Array<GraphCellQueue>,
  restore: Restore = unrestored
): Effect.Effect<ReadonlyArray<GraphFailure> | undefined> {
  if (queue.isIdle) return restore(queue.shutdown({ reason, cleanup }));
  const wait = queue
    .close(reason)
    .pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(false) })
    );
  return restore(wait).pipe(
    Effect.flatMap((drained) => {
      if (drained) return restore(queue.shutdown({ reason, cleanup }));
      late?.push(queue);
      return cleanup;
    })
  );
}
