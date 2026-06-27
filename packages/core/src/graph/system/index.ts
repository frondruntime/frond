import { Clock, Effect, Layer, Match, Semaphore } from "effect";
import { makeGraphCellActorRegistry } from "../cell/actorRegistry";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import { ensureReadyOperation, refreshOperation } from "../cell/cellOperations";
import { type NormalizedGraphSystemConfig, normalizeGraphSystemOptions } from "../config";
import { releaseCell } from "../lifecycle/cleanup";
import { evictSubgraph } from "../lifecycle/eviction";
import { ensurePlannedNode, type GraphPlanState, resolveEffectiveNodeId } from "../planning/plan";
import { projectNodeSnapshot, toSnapshot } from "../projection";
import {
  type ActionResult,
  GraphInvariantViolation,
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
  };
  const planningSemaphore = Semaphore.makeUnsafe(1);
  const actorRegistry = makeGraphCellActorRegistry();
  const refreshAdmission = makeRefreshAdmissionController();
  const planNode = (request: Parameters<GraphSystemService["ensureNode"]>[0]) =>
    Semaphore.withPermit(planningSemaphore, ensurePlannedNode(state, request));
  const submitEnsureReadyByNodeId = (nodeId: NodeRead["nodeId"]) =>
    Semaphore.withPermit(
      planningSemaphore,
      Match.value(lookupGraphNodeCell(state, nodeId)).pipe(
        Match.tag("Missing", ({ nodeId }) => Effect.succeed({ _tag: "Missing", nodeId } as const)),
        Match.tag("Found", ({ cell }) =>
          Effect.gen(function* () {
            const actor = yield* actorRegistry.getActor(cell);
            const task = yield* actor.submit(ensureReadyOperation(graphEnv, cell));
            return { _tag: "Submitted", nodeId, task } as const;
          })
        ),
        Match.exhaustive
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
      Match.value(lookupGraphNodeCell(state, nodeId)).pipe(
        Match.tag("Missing", ({ nodeId }) =>
          refreshAdmission.submit({
            request: { target: { _tag: "NodeId", nodeId } },
            cellLookup: { _tag: "Missing", nodeId },
            start: () =>
              Effect.sync(() => {
                // Structurally unreachable: refresh admission only invokes `start`
                // on the Found path. Surface the contract violation through the
                // typed invariant rather than a raw Error so the diagnostics
                // projection picks it up like every other graph invariant.
                throw new GraphInvariantViolation({
                  nodeId,
                  tag: "unknown",
                  invariant: "missing dependency refresh must not start a cell operation",
                });
              }),
          })
        ),
        Match.tag("Found", ({ cell }) =>
          refreshAdmission.submit({
            request: { target: { _tag: "NodeId", nodeId } },
            cellLookup: { _tag: "Found", cell },
            start: (cell) =>
              Effect.gen(function* () {
                const actor = yield* actorRegistry.getActor(cell);
                return yield* actor.submit(
                  refreshOperation(graphEnv, cell, {
                    target: { _tag: "NodeId", nodeId },
                  })
                );
              }),
          })
        ),
        Match.exhaustive
      )
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
        return yield* actorRegistry.shutdownActors((nodeId, actor) => {
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
        });
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
