import { Clock, Effect, Match, Semaphore } from "effect";
import type { ActionAdmission } from "../../driver";
import { canonicalKey } from "../../keys";
import type { GraphCellActor, GraphCellTask } from "../cell/cellActor";
import { type GraphNodeCellLookup, lookupGraphNodeCell } from "../cell/cellLookup";
import {
  ensureReadyOperation,
  refreshOperation,
  releaseOperation,
  runActionOperation,
  unsafeUpdateNodeOperation,
  updateArgsOperation,
} from "../cell/cellOperations";
import { submitToCellActor } from "../cell/cellSubmission";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import {
  makeActionFailure,
  makeMissingNodeActionFailure,
  makeMissingNodeUpdateArgsFailure,
  makeMissingUnsafeUpdateNodeFailure,
} from "../operations/operationFailures";
import {
  ensurePlannedNode,
  type GraphNodeCell,
  type GraphPlanState,
  resolveEffectiveNodeId,
} from "../planning/plan";
import {
  type ActionRequest,
  type ActionResult,
  GraphInvariantViolation,
  type GraphSystemService,
  type NodeId,
  type NodeRead,
  type RefreshRequest,
  type RefreshSubmission,
  type UnsafeUpdateNodeRequest,
  type UpdateNodeArgsRequest,
} from "../types";
import type { RefreshAdmissionController } from "./refreshAdmission";

export interface GraphSystemCommands {
  readonly ensureReadyNode: GraphSystemService["ensureReadyNode"];
  readonly runAction: GraphSystemService["runAction"];
  readonly submitRefreshNode: GraphSystemService["submitRefreshNode"];
  readonly refreshNode: GraphSystemService["refreshNode"];
  readonly updateNodeArgs: GraphSystemService["updateNodeArgs"];
  readonly unsafeUpdateNode: GraphSystemService["unsafeUpdateNode"];
  readonly releaseNode: GraphSystemService["releaseNode"];
  readonly executeNodeAction: (
    nodeId: NodeId,
    action: string,
    input: unknown
  ) => Effect.Effect<ActionResult>;
}

export function makeGraphSystemCommands(options: {
  readonly state: GraphPlanState;
  readonly planningSemaphore: ReturnType<typeof Semaphore.makeUnsafe>;
  readonly actorRegistry: {
    readonly getActor: (cell: GraphNodeCell) => Effect.Effect<GraphCellActor>;
  };
  readonly graphEnv: GraphOperationEnvironment;
  readonly refreshAdmission: RefreshAdmissionController;
}): GraphSystemCommands {
  const activeActionAdmissions = new Map<string, GraphCellTask<ActionResult>>();

  function runAction(request: ActionRequest) {
    return Effect.gen(function* () {
      const submission = yield* submitToTargetCell(request.target, (cell, actor) =>
        submitActionWithAdmission(cell, actor, request)
      );

      return yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", ({ nodeId }) =>
          Effect.gen(function* () {
            const result = makeMissingNodeActionFailure(nodeId, request);
            const completedAt = yield* Clock.currentTimeMillis;
            yield* options.graphEnv.state.notifyActionCompleted({
              nodeId,
              action: request.action,
              input: request.input,
              result,
              completedAt,
            });
            return result;
          })
        ),
        Match.exhaustive
      );
    });
  }

  function submitActionWithAdmission(
    cell: GraphNodeCell,
    actor: GraphCellActor,
    request: ActionRequest
  ): Effect.Effect<GraphCellTask<ActionResult>> {
    return Effect.gen(function* () {
      const action = cell.descriptor.driver.actions.read(request.action);

      if (action._tag === "Missing" || action.admission.policy === "queue") {
        return yield* actor.submit(runActionOperation(options.graphEnv, cell, request));
      }

      const admissionKey = readActionAdmissionKey(cell, request, action.admission);

      if (admissionKey._tag === "Failure") {
        return immediateActionTaskWithCompletion(
          cell,
          request,
          makeActionFailure(cell, request, admissionKey.cause)
        );
      }

      const active = activeActionAdmissions.get(admissionKey.key);

      if (active !== undefined) {
        if (action.admission.policy === "join") {
          return active;
        }

        return immediateActionTaskWithCompletion(
          cell,
          request,
          makeActionFailure(
            cell,
            request,
            new GraphInvariantViolation({
              nodeId: cell.nodeId,
              tag: cell.tag,
              invariant: "action admission rejected a concurrent request",
              cause: { action: request.action },
            })
          )
        );
      }

      const task = yield* actor.submit(runActionOperation(options.graphEnv, cell, request));
      const awaitAction = yield* Effect.cached(
        task.await.pipe(
          Effect.ensuring(Effect.sync(() => activeActionAdmissions.delete(admissionKey.key)))
        )
      );
      const tracked = {
        await: awaitAction,
      };
      activeActionAdmissions.set(admissionKey.key, tracked);
      return tracked;
    });
  }

  function immediateActionTaskWithCompletion(
    cell: GraphNodeCell,
    request: ActionRequest,
    result: ActionResult
  ): GraphCellTask<ActionResult> {
    return {
      await: Effect.gen(function* () {
        const completedAt = yield* Clock.currentTimeMillis;
        yield* options.graphEnv.state.notifyActionCompleted({
          nodeId: cell.nodeId,
          action: request.action,
          input: request.input,
          result,
          completedAt,
        });
        return result;
      }),
    };
  }

  function ensureReadyNode(request: Parameters<GraphSystemService["ensureReadyNode"]>[0]) {
    return Effect.gen(function* () {
      const submission = yield* Semaphore.withPermit(
        options.planningSemaphore,
        Effect.gen(function* () {
          const handle = yield* ensurePlannedNode(options.state, request);
          return yield* Match.value(lookupGraphNodeCell(options.state, handle.nodeId)).pipe(
            Match.tag("Missing", () => Effect.succeed({ _tag: "Missing", handle } as const)),
            Match.tag("Found", ({ cell }) =>
              Effect.gen(function* () {
                const actor = yield* options.actorRegistry.getActor(cell);
                const task = yield* actor.submit(ensureReadyOperation(options.graphEnv, cell));
                return { _tag: "Submitted", task } as const;
              })
            ),
            Match.exhaustive
          );
        })
      );

      return yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", ({ handle }) => Effect.succeed(handle)),
        Match.exhaustive
      );
    });
  }

  function refreshNode(request: RefreshRequest) {
    return Effect.gen(function* () {
      const submission = yield* submitRefreshNode(request);

      return yield* Match.value(submission).pipe(
        Match.tag("Started", ({ task }) => task.await),
        Match.tag("Joined", ({ task }) => task.await),
        Match.tag("Missing", ({ result }) => Effect.succeed(result)),
        Match.exhaustive
      );
    });
  }

  function submitRefreshNode(request: RefreshRequest): Effect.Effect<RefreshSubmission> {
    return Semaphore.withPermit(
      options.planningSemaphore,
      Effect.gen(function* () {
        const lookup = yield* resolveTargetCellWithinPermit(request.target);

        return yield* options.refreshAdmission.submit({
          request,
          cellLookup: lookup,
          start: (cell) =>
            Effect.gen(function* () {
              const actor = yield* options.actorRegistry.getActor(cell);
              return yield* actor.submit(refreshOperation(options.graphEnv, cell, request));
            }),
        });
      })
    );
  }

  function updateNodeArgs(request: UpdateNodeArgsRequest) {
    return Effect.gen(function* () {
      const submission = yield* Semaphore.withPermit(
        options.planningSemaphore,
        Effect.gen(function* () {
          const nextNodeId = resolveEffectiveNodeId(options.state, {
            spec: request.spec,
            args: request.args,
          });

          if (nextNodeId !== request.nodeId) {
            return {
              _tag: "Missing",
              nodeId: request.nodeId,
              cause: `same-identity args update resolved ${nextNodeId}`,
            } as const;
          }

          return yield* Match.value(lookupGraphNodeCell(options.state, request.nodeId)).pipe(
            Match.tag("Missing", ({ nodeId }) =>
              Effect.succeed({ _tag: "Missing", nodeId } as const)
            ),
            Match.tag("Found", ({ cell }) =>
              Effect.gen(function* () {
                const actor = yield* options.actorRegistry.getActor(cell);
                const task = yield* actor.submit(
                  updateArgsOperation(options.graphEnv, cell, request)
                );
                return { _tag: "Submitted", task } as const;
              })
            ),
            Match.exhaustive
          );
        })
      );

      return yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", (missing) =>
          Effect.succeed(
            makeMissingNodeUpdateArgsFailure(
              missing.nodeId,
              request,
              "cause" in missing ? missing.cause : undefined
            )
          )
        ),
        Match.exhaustive
      );
    });
  }

  function unsafeUpdateNode(request: UnsafeUpdateNodeRequest) {
    return Effect.gen(function* () {
      const submission = yield* submitToCellActor(
        {
          state: options.state,
          planningSemaphore: options.planningSemaphore,
          getActor: options.actorRegistry.getActor,
        },
        request.nodeId,
        (cell, actor) => actor.submit(unsafeUpdateNodeOperation(cell, request))
      );

      return yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", ({ nodeId }) =>
          Effect.succeed(makeMissingUnsafeUpdateNodeFailure(nodeId, request))
        ),
        Match.exhaustive
      );
    });
  }

  function releaseNode(nodeId: NodeId, reason?: string | undefined) {
    return Effect.gen(function* () {
      const submission = yield* Semaphore.withPermit(
        options.planningSemaphore,
        Match.value(lookupGraphNodeCell(options.state, nodeId)).pipe(
          Match.tag("Missing", ({ nodeId }) =>
            Effect.succeed({ _tag: "Missing", nodeId } as const)
          ),
          Match.tag("Found", ({ cell }) =>
            Effect.gen(function* () {
              const actor = yield* options.actorRegistry.getActor(cell);
              const task = yield* actor.submit(releaseOperation(options.graphEnv, cell, reason));
              return { _tag: "Submitted", task } as const;
            })
          ),
          Match.exhaustive
        )
      );

      yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", () => Effect.void),
        Match.exhaustive
      );
    });
  }

  function submitToTargetCell<A>(
    target: ActionRequest["target"],
    submit: (cell: GraphNodeCell, actor: GraphCellActor) => Effect.Effect<GraphCellTask<A>>
  ): Effect.Effect<
    | {
        readonly _tag: "Submitted";
        readonly task: GraphCellTask<A>;
      }
    | {
        readonly _tag: "Missing";
        readonly nodeId: NodeId;
      }
  > {
    return Semaphore.withPermit(
      options.planningSemaphore,
      resolveTargetCellWithinPermit(target).pipe(
        Effect.flatMap((lookup) =>
          Match.value(lookup).pipe(
            Match.tag("Missing", ({ nodeId }) =>
              Effect.succeed({ _tag: "Missing", nodeId } as const)
            ),
            Match.tag("Found", ({ cell }) =>
              Effect.gen(function* () {
                const actor = yield* options.actorRegistry.getActor(cell);
                const task = yield* submit(cell, actor);
                return { _tag: "Submitted", task } as const;
              })
            ),
            Match.exhaustive
          )
        )
      )
    );
  }

  function resolveTargetCellWithinPermit(
    target: ActionRequest["target"]
  ): Effect.Effect<GraphNodeCellLookup> {
    return Effect.gen(function* () {
      const handle =
        target._tag === "NodeRequest"
          ? yield* ensurePlannedNode(options.state, target.request)
          : ({
              _tag: "Unwired",
              nodeId: target.nodeId,
              status: { _tag: "Unwired" },
            } satisfies NodeRead);

      return lookupGraphNodeCell(options.state, handle.nodeId);
    });
  }

  function executeNodeAction(
    nodeId: NodeId,
    action: string,
    input: unknown
  ): Effect.Effect<ActionResult> {
    return runAction({
      target: {
        _tag: "NodeId",
        nodeId,
      },
      action,
      input,
    });
  }

  return {
    ensureReadyNode,
    runAction,
    submitRefreshNode,
    refreshNode,
    updateNodeArgs,
    unsafeUpdateNode,
    releaseNode,
    executeNodeAction,
  };
}

function readActionAdmissionKey(
  cell: GraphNodeCell,
  request: ActionRequest,
  admission: ActionAdmission
):
  | {
      readonly _tag: "Success";
      readonly key: string;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    } {
  try {
    const raw =
      admission.policy === "join"
        ? admission.admissionKey(request.input)
        : { nodeId: cell.nodeId, action: request.action };
    return {
      _tag: "Success",
      key: `${cell.nodeId}:${request.action}:${canonicalKey(raw)}`,
    };
  } catch (cause) {
    return {
      _tag: "Failure",
      cause: new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "action admission key must be canonicalizable",
        cause,
      }),
    };
  }
}
