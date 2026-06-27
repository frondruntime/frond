import { Effect, Match } from "effect";
import type { GraphCellTask } from "../cell/cellActor";
import type { GraphNodeCellLookup } from "../cell/cellLookup";
import { makeMissingNodeRefreshFailure } from "../operations/operationFailures";
import type { GraphNodeCell } from "../planning/plan";
import type {
  NodeId,
  OperationAdmission,
  OperationAdmissionKey,
  OperationAdmissionPolicy,
  RefreshRequest,
  RefreshResult,
  RefreshSubmission,
} from "../types";

const refreshAdmissionPolicy = "join" satisfies OperationAdmissionPolicy;
const refreshStartedAdmission = {
  policy: refreshAdmissionPolicy,
  outcome: "started",
} satisfies OperationAdmission;
const refreshJoinedAdmission = {
  policy: refreshAdmissionPolicy,
  outcome: "joined",
} satisfies OperationAdmission;
const refreshMissingAdmission = {
  policy: "reject",
  outcome: "rejected",
} satisfies OperationAdmission;

export interface RefreshAdmissionController {
  readonly submit: (input: {
    readonly request: RefreshRequest;
    readonly cellLookup: GraphNodeCellLookup;
    readonly start: (cell: GraphNodeCell) => Effect.Effect<GraphCellTask<RefreshResult>>;
  }) => Effect.Effect<RefreshSubmission>;
}

export function makeRefreshAdmissionController(): RefreshAdmissionController {
  const activeRefreshes = new Map<string, GraphCellTask<RefreshResult>>();

  return {
    submit: (input) =>
      Effect.gen(function* () {
        if (input.cellLookup._tag === "Missing") {
          return missingRefreshSubmission(input.request, input.cellLookup.nodeId);
        }

        const { cell } = input.cellLookup;
        const admissionKey = operationAdmissionMapKey(refreshAdmissionKey(cell.nodeId));
        const activeTask = activeRefreshes.get(admissionKey);

        // Join is the only supported refresh-admission policy today. If a second
        // policy is ever added, branch here on that policy with explicit non-join
        // handling instead of restoring the previous tautological `=== "join"`
        // guard, which silently let in-flight refreshes be overwritten.
        if (activeTask !== undefined) {
          return {
            _tag: "Joined",
            nodeId: cell.nodeId,
            admission: refreshJoinedAdmission,
            task: activeTask,
          } satisfies RefreshSubmission;
        }

        const task = yield* input.start(cell);
        const admittedTask = yield* startAdmittedRefreshTask(task, admissionKey, activeRefreshes);
        activeRefreshes.set(admissionKey, admittedTask);

        return {
          _tag: "Started",
          nodeId: cell.nodeId,
          admission: refreshStartedAdmission,
          task: admittedTask,
        } satisfies RefreshSubmission;
      }),
  };
}

function missingRefreshSubmission(request: RefreshRequest, nodeId: NodeId): RefreshSubmission {
  return {
    _tag: "Missing",
    nodeId,
    admission: refreshMissingAdmission,
    result: makeMissingNodeRefreshFailure(nodeId, request),
  } satisfies RefreshSubmission;
}

function startAdmittedRefreshTask(
  task: GraphCellTask<RefreshResult>,
  admissionKey: string,
  activeRefreshes: Map<string, GraphCellTask<RefreshResult>>
): Effect.Effect<GraphCellTask<RefreshResult>> {
  return Effect.gen(function* () {
    const awaitRefresh = yield* Effect.cached(
      task.await.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            activeRefreshes.delete(admissionKey);
          })
        )
      )
    );

    return { await: awaitRefresh };
  });
}

function refreshAdmissionKey(nodeId: NodeId): OperationAdmissionKey {
  return { _tag: "Refresh", nodeId };
}

function operationAdmissionMapKey(key: OperationAdmissionKey): string {
  return Match.value(key).pipe(
    Match.tag("Refresh", ({ nodeId }) => `refresh:${nodeId}`),
    Match.exhaustive
  );
}
