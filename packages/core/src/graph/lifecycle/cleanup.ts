import { Effect } from "effect";
import type { GraphNodeCell, GraphNodeState } from "../cell/cellModel";
import { phaseReadyData, type ReadyData } from "../cell/cellPhase";
import { completeReleaseState } from "../cell/cellTransitions";
import { makeDisposeContext } from "../driverExecution/driverContext";
import {
  recoverDriverOperationFailure,
  runTimedDriverOperation,
} from "../driverExecution/driverOperationRunner";
import { stopCurrentLiveResource } from "../liveness";
import { closeReadyNode } from "../planning/readyNodeRuntime";
import {
  type DriverOperationTimeoutMs,
  type GraphFailure,
  type LiveResourceStopReason,
  ReleaseFailed,
} from "../types";
import { type InvokedDisposers, makeDisposerRegistry } from "./disposers";
import { nodeCloseCancellation } from "./nodeLifetime";

export interface ReadyTeardownTimeouts {
  readonly release: DriverOperationTimeoutMs;
  readonly live: DriverOperationTimeoutMs;
}

// Owner: this is the single teardown sequence for a ready node generation.
// Every path that discards ready data (release, eviction, expiry re-acquire,
// planning invalidation) must run it: live stop -> driver release -> disposers
// -> close. Skipping a step leaks driver resources or subscriptions.
export function teardownReadyData(
  cell: GraphNodeCell,
  ready: ReadyData,
  timeouts: ReadyTeardownTimeouts,
  liveStopReason: LiveResourceStopReason
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  return Effect.gen(function* () {
    // Node-lifetime signal: aborts exactly once, before driver teardown hooks
    // run, so long-lived callbacks bound to ctx.nodeSignal quiesce first.
    // AbortController.abort is idempotent for repeated teardown entries.
    ready.nodeLifetime.abort(nodeCloseCancellation(liveStopReason));
    const liveFailures = yield* stopCurrentLiveResource(
      cell,
      ready.liveResource,
      timeouts.live,
      liveStopReason
    );
    // Same incarnation, same once-only set: the release hook's own registry
    // dedupes against the disposers this ready data collected, so a function
    // reachable from both paths still runs exactly once per incarnation.
    const releaseFailures = yield* runRelease(
      cell,
      ready.node,
      timeouts.release,
      ready.disposers.invoked
    );
    const disposerFailures = yield* ready.disposers.drain(cell, timeouts.release);
    closeReadyNode(ready.node);
    return [...liveFailures, ...releaseFailures, ...disposerFailures];
  });
}

export function releaseCell(
  cell: GraphNodeCell,
  timeout: DriverOperationTimeoutMs,
  liveTimeout: DriverOperationTimeoutMs,
  liveStopReason: LiveResourceStopReason
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  return Effect.gen(function* () {
    const current = yield* cell.state.get;
    const ready = phaseReadyData(current.phase);
    const cleanupFailures =
      ready._tag === "Found"
        ? yield* teardownReadyData(
            cell,
            ready.ready,
            { release: timeout, live: liveTimeout },
            liveStopReason
          )
        : [];
    yield* cell.state.replace(releasedGraphNodeState(current, cleanupFailures));
    return cleanupFailures;
  });
}

function releasedGraphNodeState(
  current: GraphNodeState,
  cleanupFailures: ReadonlyArray<GraphFailure>
): GraphNodeState {
  return completeReleaseState({ latest: current, cleanupFailures });
}

function runRelease(
  cell: GraphNodeCell,
  node: object,
  timeout: DriverOperationTimeoutMs,
  invoked: InvokedDisposers
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  const { release } = cell.descriptor.driver;

  if (release._tag === "Missing") {
    return Effect.succeed([]);
  }

  const abortController = new AbortController();
  // Sibling registry of the same incarnation: fresh list, shared invoked set,
  // so release-hook disposers dedupe against everything the ready data ran.
  const releaseDisposers = makeDisposerRegistry(invoked);
  const ctx = makeDisposeContext({
    node,
    abortController,
    disposers: {
      add: (disposer) => {
        releaseDisposers.add(disposer);
      },
    },
  });

  return Effect.gen(function* () {
    const releaseFailures = yield* recoverDriverOperationFailure(
      runTimedDriverOperation({
        cell,
        operation: "release",
        boundary: "driver-release",
        timeout,
        abortController,
        spanName: "frond.graph.release.driver",
        spanAttributes: {
          "frond.node.id": cell.nodeId,
          "frond.node.tag": cell.tag,
          "frond.driver.mode": cell.descriptor.driver.mode,
        },
        run: () => release.run(ctx),
      }).pipe(Effect.as([] as ReadonlyArray<GraphFailure>)),
      "driver-release",
      (cause) => Effect.succeed([toReleaseFailed(cell, cause)])
    );
    // Release-hook disposers get the same drain semantics as ready-data
    // disposers: bounded per disposer, and one registered during the drain
    // still runs and is awaited.
    const disposerFailures = yield* releaseDisposers.drain(cell, timeout);

    return [...releaseFailures, ...disposerFailures];
  });
}

function toReleaseFailed(cell: GraphNodeCell, cause: unknown): ReleaseFailed {
  return cause instanceof ReleaseFailed
    ? cause
    : new ReleaseFailed({ nodeId: cell.nodeId, tag: cell.tag, cause });
}
