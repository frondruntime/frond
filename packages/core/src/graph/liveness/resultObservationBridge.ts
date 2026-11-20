import { Cause, Effect, Exit } from "effect";
import { corePromise } from "../../runtime/promiseFacade";
import { canonicalKey } from "../planning/canonicalKey";
import { type GraphResume, noCancel } from "../queue/reply";
import type { GraphFailure, NodeId, NodeLiveScopeKey, ObservedResultLease } from "../types";
import { GraphInvariantViolation } from "../types";

const missingObservedLease: ObservedResultLease = { _tag: "Missing" };

type ResultObservedReporterState = {
  readonly reportResultObserved: (
    nodeId: NodeId,
    scope: unknown,
    observed: boolean,
    lease: ObservedResultLease
  ) => Promise<ObservedResultLease>;
  readonly notifyLiveFailures: (
    nodeId: NodeId,
    failures: ReadonlyArray<GraphFailure>
  ) => Effect.Effect<void>;
};

type ResultObservedReporterNode = {
  readonly nodeId: NodeId;
  readonly tag: string;
};

export function bridgeObservedResultLease(
  start: (resume: GraphResume<ObservedResultLease>) => void
): Promise<ObservedResultLease> {
  // Boundary: MobX/node observation callbacks are synchronous, while graph live
  // lease acquisition settles through the job queue. This named bridge keeps
  // that escape local to result observation. An interrupted lease call reads
  // as Missing; any other failure rejects with its squashed value, an empty
  // cause included.
  return corePromise<ObservedResultLease, never>((resume) => {
    start((exit) => {
      if (Exit.isSuccess(exit)) resume(exit);
      else if (Cause.hasInterruptsOnly(exit.cause)) resume(Exit.succeed(missingObservedLease));
      else resume(Exit.die(Cause.squash(exit.cause)));
    });
    return noCancel;
  });
}

export function makeResultObservedReporter(
  state: ResultObservedReporterState,
  node: ResultObservedReporterNode
): (scope: unknown, observed: boolean) => void {
  const leases = new Map<NodeLiveScopeKey, ObservedResultLease>();
  let sync = Promise.resolve();

  return (scope, observed) => {
    const scopeKey = liveReporterScopeKey(scope);

    // Hazard: observation callbacks can arrive back-to-back from MobX. Serialize
    // lease changes and heal rejection so one failed report cannot poison later
    // observe/unobserve notifications.
    sync = sync
      .then(() => {
        const currentLease =
          scopeKey === undefined
            ? ({ _tag: "Missing" } as const)
            : (leases.get(scopeKey) ?? { _tag: "Missing" });

        return state.reportResultObserved(node.nodeId, scope, observed, currentLease);
      })
      .then((nextLease) => {
        if (scopeKey === undefined) {
          return;
        }

        if (nextLease._tag === "Missing") {
          leases.delete(scopeKey);
          return;
        }

        leases.set(scopeKey, nextLease);
      })
      .catch((cause) => {
        const failure = new GraphInvariantViolation({
          nodeId: node.nodeId,
          tag: node.tag,
          invariant: "result observation reporting failed",
          cause,
        });

        return Effect.runPromise(
          state
            .notifyLiveFailures(node.nodeId, [failure])
            .pipe(Effect.catchCause(() => Effect.void))
        );
      });
  };
}

function liveReporterScopeKey(scope: unknown): NodeLiveScopeKey | undefined {
  try {
    return canonicalKey(scope) as unknown as NodeLiveScopeKey;
  } catch {
    return undefined;
  }
}
