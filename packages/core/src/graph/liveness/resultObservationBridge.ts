import { Effect } from "effect";
import { canonicalKey } from "../planning/canonicalKey";
import type { GraphFailure, NodeId, NodeLiveScopeKey, ObservedResultLease } from "../types";
import { GraphInvariantViolation } from "../types";

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
  effect: Effect.Effect<ObservedResultLease>
): Promise<ObservedResultLease> {
  // Boundary: MobX/node observation callbacks are synchronous, while graph live
  // lease acquisition is Effect-native. This named bridge keeps that escape
  // local to result observation.
  return Effect.runPromise(effect);
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
