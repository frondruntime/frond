import { type Context, Effect, Fiber, Layer } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import type { GraphPlanState } from "../cell/cellModel";
import { projectCellPhase } from "../cell/cellPhase";
import type { GraphCellQueue } from "../cell/cellQueue";
import { makeGraphCellQueueRegistry } from "../cell/queueRegistry";
import { type NormalizedGraphSystemConfig, normalizeGraphSystemOptions } from "../config";
import { runEffectEdge } from "../driverExecution/effectRunner";
import { releaseCell } from "../lifecycle/cleanup";
import { evictSubgraph } from "../lifecycle/eviction";
import { runDependentsFirst, shutdownWithin, teardownPlan } from "../lifecycle/teardownOrder";
import type { EnsureReadyDependencySubmission } from "../operations/dependencies";
import { resolveEffectiveNodeId } from "../planning/identity";
import { ensurePlannedNodeSync } from "../planning/plan";
import { projectNodeSnapshot } from "../projection";
import { GraphGate, planTask } from "../queue/graphGate";
import { makeGraphJobQueue } from "../queue/jobQueue";
import { callbackEffect, completedTask, type GraphCellTask } from "../queue/reply";
import { submitReadiness } from "../readiness/submission";
import {
  type ActionResult,
  type GraphFailure,
  type GraphNodeCleanupResult,
  GraphSystem,
  type GraphSystemOptions,
  type GraphSystemService,
  type NodeId,
  type NodeRead,
  type NodeSnapshotLookup,
  type PendingNodeOperation,
  type SystemStatus,
} from "../types";
import type { GraphSystemCore, GraphSystemInstance } from "./core";
import { makeRefreshAdmissionController } from "./refreshAdmission";
import { type GraphSystemCommands, makeGraphSystemCommands } from "./systemCommands";
import { type GraphSystemLiveness, makeGraphSystemLiveness } from "./systemLiveness";
import { makeGraphSystemObservers } from "./systemObservers";

type StopQueue = readonly [NodeId, GraphCellQueue];
// Stands in for a cleanup slot the stop loop always fills.
const noCleanup: Effect.Effect<ReadonlyArray<GraphFailure>> = Effect.succeed([]);

export function makeInMemoryGraphSystem(options: GraphSystemOptions): GraphSystemService {
  return makeInMemoryGraphSystemFromConfig(normalizeGraphSystemOptions(options)).service;
}

export function makeInMemoryGraphSystemFromConfig(
  config: NormalizedGraphSystemConfig
): GraphSystemInstance {
  let status: SystemStatus = "idle";
  let observedInputs = 0;
  const observers = makeGraphSystemObservers();
  const jobs = makeGraphJobQueue();
  const queueRegistry = makeGraphCellQueueRegistry(jobs);
  // Forward references: `liveness` and `commands` are captured by closures in
  // `state` (e.g. `executeNodeAction`, `nextLiveLeaseId`) before assignment.
  // This is safe because no `state` method is invoked during construction —
  // they are only called after both `liveness` and `commands` are assigned below.
  let liveness: GraphSystemLiveness;
  let commands: GraphSystemCommands;

  const state: GraphPlanState = {
    development: config.development,
    jobs,
    syncClock: config.syncClock,
    enqueue: (effect) =>
      jobs.post({
        run: () => {
          Effect.runFork(effect);
        },
      }),
    nodes: new Map(),
    edges: new Map(),
    evictedRevisionFloor: -1,
    wiringGeneration: 1,
    specByTag: new Map(),
    specOverrides: config.specOverrides,
    driverTimeouts: config.driverTimeouts,
    nextLiveLeaseId: () => liveness.nextLiveLeaseId(),
    executeNodeAction,
    executeNodeActionDirect: (nodeId, action, input, context, resume) =>
      commands.core.executeNodeAction(nodeId, action, input, context, resume),
    notifyNodeChanged: observers.notifyNodeChanged,
    notifyOperationStarted: observers.notifyOperationStarted,
    notifyActionCompleted: observers.notifyActionCompleted,
    notifyResultValidityChanged: observers.notifyResultValidityChanged,
    notifyReadinessFailed: observers.notifyReadinessFailed,
    reportObserverFailure: observers.reportObserverFailure,
    notifyLiveDemandChanged: observers.notifyLiveDemandChanged,
    notifyLiveFailures: observers.notifyLiveFailures,
    notifyCleanupFailures: observers.notifyCleanupFailures,
    reportResultObserved: (nodeId, scope, observed, leaseId) =>
      liveness.reportResultObserved(nodeId, scope, observed, leaseId),
    cellQueues: {
      getExistingQueue: (nodeId) => queueRegistry.getExistingQueue(nodeId),
      deleteQueue: (nodeId, queue) => queueRegistry.deleteQueue(nodeId, queue),
    },
  };
  const gate = new GraphGate(jobs);
  const refreshAdmission = makeRefreshAdmissionController();
  // The one ready-by-id body: the node's readiness task, or undefined for an unplanned id.
  const submitReadinessById = (
    nodeId: NodeId,
    context: Context.Context<never> | undefined
  ): GraphCellTask<NodeRead> | undefined => {
    const cell = state.nodes.get(nodeId);
    return cell === undefined ? undefined : submitReadiness(queueRegistry, graphEnv, cell, context);
  };
  const handleInputSync = (): void => {
    observedInputs += 1;
  };
  const graphEnv = {
    runtimeSpanAttributes: config.runtimeSpanAttributes,
    state,
    submitEnsureReadyDirect: (
      nodeId: NodeId,
      context: import("effect").Context.Context<never> | undefined,
      resume: import("../queue/reply").GraphResume<
        import("../operations/dependencies").EnsureReadyDependencySubmission
      >
    ) =>
      gate.planDirect(
        (context): EnsureReadyDependencySubmission => {
          const task = submitReadinessById(nodeId, context);
          return task === undefined
            ? { _tag: "Missing", nodeId }
            : { _tag: "Submitted", nodeId, task };
        },
        context,
        resume,
        true
      ),
    submitRefreshDirect: (
      nodeId: NodeId,
      context: import("effect").Context.Context<never> | undefined,
      resume: import("../queue/reply").GraphResume<
        import("./refreshAdmission").CoreRefreshSubmission
      >
    ) => commands.submitRefreshDirect({ target: { _tag: "NodeId", nodeId } }, context, resume),
    driverTimeouts: config.driverTimeouts,
    signals: config.signals,
  };
  liveness = makeGraphSystemLiveness({
    state,
    gate,
    queueRegistry,
    graphEnv,
    observers,
  });
  commands = makeGraphSystemCommands({
    state,
    gate,
    queueRegistry,
    graphEnv,
    refreshAdmission,
  });

  const graph: GraphSystemService = {
    start: () =>
      Effect.sync(() => {
        status = "running";
      }),
    stop: () =>
      gate.run(
        Effect.gen(function* () {
          status = "stopped";
          const queues = queueRegistry.closeForShutdown();
          const count = queues.length;
          const nodeIds = new Array<NodeId>(count);
          const cleanups = new Array<Effect.Effect<ReadonlyArray<GraphFailure>>>(count);
          for (let index = 0; index < count; index += 1) {
            const nodeId = (queues[index] as StopQueue)[0];
            nodeIds[index] = nodeId;
            cleanups[index] = stopCleanup(nodeId);
          }
          const reason: RuntimeCancellationReason = { _tag: "RuntimeStopped" };
          // Interrupt every cell's work at once without waiting for it to
          // drain. Then shut each node down (wait for its own drain, then
          // clean up) as soon as all of its dependents in the set have
          // finished, every node otherwise concurrently: one cell's canceled
          // work holds back only its own cleanup and its dependencies', and
          // for at most the release timeout.
          const closing = yield* Effect.forkChild(
            Effect.forEach(queues, (entry) => entry[1].close(reason), {
              concurrency: "unbounded",
              discard: true,
            }),
            { startImmediately: true }
          );
          const failuresByNode = yield* runDependentsFirst(
            teardownPlan(nodeIds, state.edges),
            (index) =>
              shutdownWithin(
                (queues[index] as StopQueue)[1],
                reason,
                cleanups[index] ?? noCleanup,
                config.driverTimeouts.release
              )
          );
          // A drain that outlived its bound is still running: stop ends only
          // once every cell's canceled work has drained.
          yield* Fiber.join(closing);
          // Results keep the order of the queue snapshot.
          const results = new Array<GraphNodeCleanupResult>(count);
          for (let index = 0; index < count; index += 1) {
            results[index] = {
              nodeId: nodeIds[index] as NodeId,
              failures: failuresByNode[index] ?? [],
            };
          }
          return results;
        })
      ),
    resolveNodeIdSync: (request) => resolveEffectiveNodeId(state, request),
    ensureNode: (request) =>
      callbackEffect((context, resume) => core.ensureNode(request, context, resume)),
    ensureReadyNode: commands.ensureReadyNode,
    ensureReadyNodeById: (nodeId) =>
      callbackEffect((context, resume) => core.ensureReadyNodeById(nodeId, context, resume)),
    runAction: commands.runAction,
    submitRefreshNode: commands.submitRefreshNode,
    refreshNode: commands.refreshNode,
    updateNodeArgs: commands.updateNodeArgs,
    unsafeUpdateNode: commands.unsafeUpdateNode,
    releaseNode: commands.releaseNode,
    evictSubgraph: (request) =>
      gate.run(
        evictSubgraph(
          {
            state,
            queues: queueRegistry.queues,
            getExistingQueue: queueRegistry.getExistingQueue,
            clearRefreshAdmission: (nodeId) =>
              Effect.sync(() => refreshAdmission.clearNode(nodeId)),
            driverTimeouts: config.driverTimeouts,
          },
          request
        )
      ),
    acquireNodeLiveLease: liveness.acquireNodeLiveLease,
    releaseNodeLiveLease: liveness.releaseNodeLiveLease,
    readNodeSnapshotSync: (nodeId, context) => {
      const lookup = lookupGraphNodeCell(state, nodeId);
      switch (lookup._tag) {
        case "Missing": {
          const { nodeId } = lookup;
          return { _tag: "Missing", nodeId } satisfies NodeSnapshotLookup;
        }
        case "Found": {
          const { cell } = lookup;
          return {
            _tag: "Found",
            snapshot: projectNodeSnapshot(cell, cell.state.getSync(), context),
          } satisfies NodeSnapshotLookup;
        }
        default: {
          const unreachable: never = lookup;
          return unreachable;
        }
      }
    },
    // Narrow revision read: no clock, no projection — just the cell's
    // committed-write counter. Missing cells report 0 (pre-materialization).
    readNodeRevisionSync: (nodeId) => {
      const lookup = lookupGraphNodeCell(state, nodeId);

      return lookup._tag === "Missing" ? 0 : lookup.cell.state.getRevisionSync();
    },
    // Narrow pending-operation scan: only each cell's phase-projected operation,
    // never the event buffer, edges, or a full per-node snapshot. Answers on a
    // not-yet-started or stopped graph exactly like the full snapshot does.
    readPendingOperationsSync: () => {
      const pending: Array<PendingNodeOperation> = [];

      for (const cell of state.nodes.values()) {
        const projection = projectCellPhase(cell.state.getSync().phase);

        if (projection._tag !== "Removed" && projection.operation._tag === "Running") {
          pending.push({ nodeId: cell.nodeId, tag: cell.tag, operation: projection.operation });
        }
      }

      return pending;
    },
    readNodeSnapshot: (nodeId, context) => {
      const lookup = lookupGraphNodeCell(state, nodeId);
      switch (lookup._tag) {
        case "Missing": {
          const { nodeId } = lookup;
          return Effect.succeed({ _tag: "Missing", nodeId } satisfies NodeSnapshotLookup);
        }
        case "Found": {
          const { cell } = lookup;
          return Effect.gen(function* () {
            const projectionContext =
              context === undefined ? { now: config.syncClock.now() } : context;
            const cellState = yield* cell.state.get;
            return {
              _tag: "Found",
              snapshot: projectNodeSnapshot(cell, cellState, projectionContext),
            } satisfies NodeSnapshotLookup;
          });
        }
        default: {
          const unreachable: never = lookup;
          return unreachable;
        }
      }
    },
    observeNodeChanges: observers.observeNodeChanges,
    observeResultValidityChanges: observers.observeResultValidityChanges,
    observeLiveDemandChanges: observers.observeLiveDemandChanges,
    observeLiveFailures: observers.observeLiveFailures,
    observeReadinessFailures: observers.observeReadinessFailures,
    observeCleanupFailures: observers.observeCleanupFailures,
    observeOperationStarts: observers.observeOperationStarts,
    observeActionCompletions: observers.observeActionCompletions,
    observeObserverFailures: observers.observeObserverFailures,
    // Ingest channel is a stub today: this counter tallies how many inputs
    // arrived so snapshots can report it, but the payload itself has no
    // consumer yet. Wire payload routing here when an ingestion contract lands.
    handleInput: (_input) => Effect.sync(handleInputSync),
    snapshot: (context) => Effect.sync(() => snapshotSync(context)),
  };

  const core: GraphSystemCore = {
    ...commands.core,
    jobs,
    snapshotSync,
    handleInputSync,
    start: (context, resume) =>
      gate.planDirect(
        () => {
          status = "running";
        },
        context,
        resume
      ),
    stop: (context, resume) => runEffectEdge(graph.stop(), context, resume),
    ensureNode: (request, context, resume) =>
      gate.planDirect(() => ensurePlannedNodeSync(state, request), context, resume),
    ensureReadyNodeById: (nodeId, context, resume) =>
      planTask(
        gate,
        (context) =>
          submitReadinessById(nodeId, context) ??
          completedTask<NodeRead>({ _tag: "Unwired", nodeId, status: { _tag: "Unwired" } }),
        context,
        resume,
        true
      ),
    evictSubgraph: (request, context, resume) =>
      runEffectEdge(graph.evictSubgraph(request), context, resume),
    acquireNodeLiveLease: (request, context, resume) =>
      runEffectEdge(graph.acquireNodeLiveLease(request), context, resume),
    releaseNodeLiveLease: (request, context, resume) =>
      runEffectEdge(graph.releaseNodeLiveLease(request), context, resume),
  };
  return { service: graph, core };

  function snapshotSync(
    context?: import("../types").ProjectionContext
  ): import("../types").SystemSnapshot {
    const projection = context ?? { now: config.syncClock.now() };
    const nodes: import("../types").NodeSnapshot[] = [];
    for (const cell of state.nodes.values())
      nodes.push(projectNodeSnapshot(cell, cell.state.getSync(), projection));
    return { status, observedInputs, nodes, edges: [...state.edges.values()] };
  }

  function stopCleanup(nodeId: NodeId): Effect.Effect<ReadonlyArray<GraphFailure>> {
    const lookup = lookupGraphNodeCell(state, nodeId);
    switch (lookup._tag) {
      case "Missing": {
        return Effect.succeed([]);
      }
      case "Found": {
        return releaseCell(
          state,
          lookup.cell,
          config.driverTimeouts.release,
          config.driverTimeouts.live,
          { _tag: "GraphStopped" }
        );
      }
      default: {
        const unreachable: never = lookup;
        return unreachable;
      }
    }
  }

  function executeNodeAction(
    nodeId: NodeId,
    action: string,
    input: unknown
  ): Effect.Effect<ActionResult> {
    return commands.executeNodeAction(nodeId, action, input);
  }
}

export const GraphSystemLive = (options: GraphSystemOptions): Layer.Layer<GraphSystem> =>
  Layer.effect(GraphSystem)(
    Effect.gen(function* () {
      const graph = makeInMemoryGraphSystem(options);
      yield* Effect.addFinalizer(() => graph.stop().pipe(Effect.asVoid));
      return GraphSystem.of(graph);
    })
  );
