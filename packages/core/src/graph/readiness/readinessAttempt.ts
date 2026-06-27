import { Deferred, Effect } from "effect";
import {
  type CellBase,
  type CellPhase,
  type CellReadinessAttempt,
  phaseBase,
} from "../cell/cellPhase";
import { beginReadinessAttemptState, failReadinessAttemptState } from "../cell/cellTransitions";
import type { GraphNodeCell } from "../planning/plan";
import { GraphInvariantViolation, type NodeRead, type ResultValidity } from "../types";

export function runReadinessAttempt(
  cell: GraphNodeCell,
  base: CellBase,
  body: (attempt: CellReadinessAttempt) => Effect.Effect<NodeRead>
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const current = yield* cell.state.get;
    const attemptId = current.nextAttemptId + 1;
    const deferred = yield* Deferred.make<NodeRead>();
    const attempt = makeCellReadinessAttempt(attemptId, deferred);

    yield* cell.state.transition((latest) => [
      undefined,
      beginReadinessAttemptState({ latest, attemptId, base, attempt }),
    ]);
    yield* cell.notifyChanged(cell.nodeId);

    return yield* body(attempt);
  });
}

export function failAttempt(
  cell: GraphNodeCell,
  attempt: CellReadinessAttempt,
  cause: unknown,
  resultValidity?: ResultValidity | undefined
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const status = { _tag: "Wired", run: { _tag: "Error", error: cause } } as const;
    yield* cell.state.transition((latest) => [
      undefined,
      failReadinessAttemptState({ latest, cause, resultValidity }),
    ]);
    yield* cell.notifyChanged(cell.nodeId);

    const latest = yield* cell.state.get;
    const handle = failedReadFromPhase(cell, latest.phase, cause, status);
    yield* completeAttempt(attempt, handle);
    return handle;
  });
}

export function completeAttempt(
  attempt: CellReadinessAttempt,
  handle: NodeRead
): Effect.Effect<void> {
  return Deferred.succeed(attempt.deferred, handle).pipe(
    Effect.tap(() => Effect.sync(() => attempt.resolve(handle))),
    Effect.asVoid
  );
}

function resultValidityFromPhase(phase: CellPhase): ResultValidity | undefined {
  const base = phaseBase(phase);

  return base._tag === "Found" ? base.base.resultValidity : undefined;
}

function failedReadFromPhase(
  cell: GraphNodeCell,
  phase: CellPhase,
  cause: unknown,
  status: Extract<NodeRead, { readonly _tag: "Error" }>["status"]
): NodeRead {
  const base = phaseBase(phase);
  const resultValidity = resultValidityFromPhase(phase);

  if (base._tag === "Found") {
    return {
      _tag: "Error",
      nodeId: cell.nodeId,
      tag: cell.tag,
      status,
      error: cause,
      resultValidity,
    };
  }

  const error = new GraphInvariantViolation({
    nodeId: cell.nodeId,
    tag: cell.tag,
    invariant: "failed readiness attempt must retain graph-owned node base",
    cause: { phase: base.phase, readinessFailure: cause },
  });

  return {
    _tag: "Invalid",
    nodeId: cell.nodeId,
    tag: cell.tag,
    status: { _tag: "Invalid", error },
    nodeLookup: { _tag: "Missing" },
    error,
    resultValidity,
  };
}

function makeCellReadinessAttempt(
  attemptId: number,
  deferred: Deferred.Deferred<NodeRead>
): CellReadinessAttempt {
  let resolve!: (handle: NodeRead) => void;
  const promise = new Promise<NodeRead>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    attemptId,
    deferred,
    promise,
    resolve,
  };
}
