import { Clock, Effect, Layer, Match, Semaphore } from "effect";
import { makeGraphCellActorRegistry } from "../cell/actorRegistry";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import type { GraphPlanState } from "../cell/cellModel";
import { ensureReadyOperation, refreshOperation } from "../cell/cellOperations";
import { submitToCellActor } from "../cell/cellSubmission";
import { type NormalizedGraphSystemConfig, normalizeGraphSystemOptions } from "../config";
import { releaseCell } from "../lifecycle/cleanup";
import { evictSubgraph } from "../lifecycle/eviction";
import { resolveEffectiveNodeId } from "../planning/identity";
import { ensurePlannedNode } from "../planning/plan";
import { projectNodeSnapshot, toSnapshot } from "../projection";
import {
  type ActionResult,
  type GraphNodeCleanupResult,
  GraphSystem,
  type GraphSystemOptions,
  type GraphSystemService,
  type NodeId,
  type NodeRead,
  type NodeSnapshotLookup,
  type SystemStatus,
} from "../types";
import { makeRefreshAdmissionController } from "./refreshAdmission";
import { type GraphSystemCommands, makeGraphSystemCommands } from "./systemCommands";
import { type GraphSystemLiveness, makeGraphSystemLiveness } from "./systemLiveness";
import { makeGraphSystemObservers } from "./systemObservers";

export function makeInMemoryGraphSystem(options: GraphSystemOptions): GraphSystemService {
  return makeInMemoryGraphSystemFromConfig(normalizeGraphSystemOptions(options));
}

export function makeInMemoryGraphSystemFromConfig(
  config: NormalizedGraphSystemConfig
): GraphSystemService {
  let status: SystemStatus = "idle";
  let observedInputs = 0;
  const observers = makeGraphSystemObservers();
  const actorRegistry = makeGraphCellActorRegistry();
  // Forward references: `liveness` and `commands` are captured by closures in
  // `state` (e.g. `executeNodeAction`, `nextLiveLeaseId`) before assignment.
  // This is safe because no `state` method is invoked during construction —
  // they are only called after both `liveness` and `commands` are assigned below.
  let liveness: GraphSystemLiveness;
  let commands: GraphSystemCommands;

  const state: GraphPlanState = {
    nodes: new Map(),
    edges: new Map(),
    specByTag: new Map(),
    specOverrides: config.specOverrides,
    driverTimeouts: config.driverTimeouts,
    nextLiveLeaseId: () => liveness.nextLiveLeaseId(),
    executeNodeAction,
    notifyNodeChanged: observers.notifyNodeChanged,
    notifyOperationStarted: observers.notifyOperationStarted,
    notifyActionCompleted: observers.notifyActionCompleted,
    notifyResultValidityChanged: observers.notifyResultValidityChanged,
    notifyLiveDemandChanged: observers.notifyLiveDemandChanged,
    notifyLiveFailures: observers.notifyLiveFailures,
    notifyCleanupFailures: observers.notifyCleanupFailures,
    reportResultObserved: (nodeId, scope, observed, leaseId) =>
      liveness.reportResultObserved(nodeId, scope, observed, leaseId),
    cellActors: {
      getExistingActor: (nodeId) => actorRegistry.getExistingActor(nodeId),
      deleteActor: (nodeId, actor) => actorRegistry.deleteActor(nodeId, actor),
    },
  };
  const planningSemaphore = Semaphore.makeUnsafe(1);
  const refreshAdmission = makeRefreshAdmissionController();
  const planNode = (request: Parameters<GraphSystemService["ensureNode"]>[0]) =>
    Semaphore.withPermit(planningSemaphore, ensurePlannedNode(state, request));
  const submitEnsureReadyByNodeId = (nodeId: NodeRead["nodeId"]) =>
    submitToCellActor(
      {
        state,
        planningSemaphore,
        submit: actorRegistry.submit,
      },
      nodeId,
      (cell) => ensureReadyOperation(graphEnv, cell)
    ).pipe(
      Effect.map((submission) =>
        submission._tag === "Missing"
          ? submission
          : ({ _tag: "Submitted", nodeId, task: submission.task } as const)
      )
    );
  const ensureReadyNodeById = (nodeId: NodeRead["nodeId"]): Effect.Effect<NodeRead> =>
    Effect.gen(function* () {
      const submission = yield* submitEnsureReadyByNodeId(nodeId);

      return yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", ({ nodeId }) =>
          Effect.succeed({
            _tag: "Unwired",
            nodeId,
            status: { _tag: "Unwired" },
          } satisfies NodeRead)
        ),
        Match.exhaustive
      );
    });
  const submitRefreshByNodeId = (nodeId: NodeRead["nodeId"]) =>
    Semaphore.withPermit(
      planningSemaphore,
      refreshAdmission.submit({
        request: { target: { _tag: "NodeId", nodeId } },
        cellLookup: lookupGraphNodeCell(state, nodeId),
        start: (cell, onComplete) =>
          actorRegistry.submit(
            cell,
            refreshOperation(graphEnv, cell, {
              target: { _tag: "NodeId", nodeId },
            }),
            { onComplete }
          ),
      })
    );
  const graphEnv = {
    runtimeSpanAttributes: config.runtimeSpanAttributes,
    state,
    submitEnsureReadyByNodeId,
    submitRefreshByNodeId,
    driverTimeouts: config.driverTimeouts,
    signals: config.signals,
  };
  liveness = makeGraphSystemLiveness({
    state,
    planningSemaphore,
    actorRegistry,
    graphEnv,
    observers,
  });
  commands = makeGraphSystemCommands({
    state,
    planningSemaphore,
    actorRegistry,
    graphEnv,
    refreshAdmission,
  });

  return {
    start: () =>
      Effect.sync(() => {
        status = "running";
      }),
    stop: () =>
      Effect.gen(function* () {
        status = "stopped";
        const actors = yield* Semaphore.withPermit(
          planningSemaphore,
          actorRegistry.closeForShutdown()
        );
        return yield* Effect.forEach(
          actors,
          ([nodeId, actor]) => {
            const cleanup = Match.value(lookupGraphNodeCell(state, nodeId)).pipe(
              Match.tag("Missing", () => Effect.succeed([])),
              Match.tag("Found", ({ cell }) =>
                releaseCell(cell, config.driverTimeouts.release, config.driverTimeouts.live, {
                  _tag: "GraphStopped",
                })
              ),
              Match.exhaustive
            );

            return actor
              .shutdown({
                reason: { _tag: "RuntimeStopped" },
                cleanup,
              })
              .pipe(
                Effect.map(
                  (failures): GraphNodeCleanupResult => ({
                    nodeId,
                    failures: failures ?? [],
                  })
                )
              );
          },
          { concurrency: "unbounded" }
        );
      }),
    resolveNodeIdSync: (request) => resolveEffectiveNodeId(state, request),
    ensureNode: (request) => planNode(request),
    ensureReadyNode: commands.ensureReadyNode,
    ensureReadyNodeById,
    runAction: commands.runAction,
    submitRefreshNode: commands.submitRefreshNode,
    refreshNode: commands.refreshNode,
    updateNodeArgs: commands.updateNodeArgs,
    unsafeUpdateNode: commands.unsafeUpdateNode,
    releaseNode: commands.releaseNode,
    evictSubgraph: (request) =>
      Semaphore.withPermit(
        planningSemaphore,
        evictSubgraph(
          {
            state,
            actors: actorRegistry.actors,
            getExistingActor: actorRegistry.getExistingActor,
            clearRefreshAdmission: refreshAdmission.clearNode,
            driverTimeouts: config.driverTimeouts,
          },
          request
        )
      ),
    acquireNodeLiveLease: liveness.acquireNodeLiveLease,
    releaseNodeLiveLease: liveness.releaseNodeLiveLease,
    readNodeSnapshotSync: (nodeId, context) => {
      return Match.value(lookupGraphNodeCell(state, nodeId)).pipe(
        Match.tag(
          "Missing",
          ({ nodeId }) => ({ _tag: "Missing", nodeId }) satisfies NodeSnapshotLookup
        ),
        Match.tag(
          "Found",
          ({ cell }) =>
            ({
              _tag: "Found",
              snapshot: projectNodeSnapshot(cell, cell.state.getSync(), context),
            }) satisfies NodeSnapshotLookup
        ),
        Match.exhaustive
      );
    },
    readNodeSnapshot: (nodeId, context) =>
      Match.value(lookupGraphNodeCell(state, nodeId)).pipe(
        Match.tag("Missing", ({ nodeId }) =>
          Effect.succeed({ _tag: "Missing", nodeId } satisfies NodeSnapshotLookup)
        ),
        Match.tag("Found", ({ cell }) =>
          Effect.gen(function* () {
            const projectionContext =
              context === undefined ? { now: yield* Clock.currentTimeMillis } : context;
            const cellState = yield* cell.state.get;
            return {
              _tag: "Found",
              snapshot: projectNodeSnapshot(cell, cellState, projectionContext),
            } satisfies NodeSnapshotLookup;
          })
        ),
        Match.exhaustive
      ),
    observeNodeChanges: observers.observeNodeChanges,
    observeResultValidityChanges: observers.observeResultValidityChanges,
    observeLiveDemandChanges: observers.observeLiveDemandChanges,
    observeLiveFailures: observers.observeLiveFailures,
    observeCleanupFailures: observers.observeCleanupFailures,
    observeOperationStarts: observers.observeOperationStarts,
    observeActionCompletions: observers.observeActionCompletions,
    observeObserverFailures: observers.observeObserverFailures,
    // Ingest channel is a stub today: this counter tallies how many inputs
    // arrived so snapshots can report it, but the payload itself has no
    // consumer yet. Wire payload routing here when an ingestion contract lands.
    handleInput: (_input) =>
      Effect.sync(() => {
        observedInputs += 1;
      }),
    snapshot: (context) =>
      Effect.gen(function* () {
        const projectionContext =
          context === undefined ? { now: yield* Clock.currentTimeMillis } : context;
        const nodes = yield* Effect.forEach(
          [...state.nodes.values()],
          (cell) => toSnapshot(cell, projectionContext),
          {
            concurrency: 1,
          }
        );

        return {
          status,
          observedInputs,
          nodes,
          edges: [...state.edges.values()],
        };
      }),
  };

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
