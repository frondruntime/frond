import type { NodeId, NodeRequest } from "../graph";
import type { CoreCall } from "../graph/queue/reply";
import type { RuntimeSignalSubscriber, RuntimeSignalSubscription } from "../signals";
import type {
  RuntimeHostService,
  RuntimeObserver,
  RuntimeQuery,
  RuntimeQueryResult,
  RuntimeSnapshot,
  RuntimeSubscription,
} from "./types";
export interface RuntimeCore {
  readonly submit: CoreCall<RuntimeHostService["submit"]>;
  readonly control: CoreCall<RuntimeHostService["control"]>;
  readonly ingest: CoreCall<RuntimeHostService["ingest"]>;
  readonly publish: CoreCall<RuntimeHostService["publish"]>;
  readonly recordUnsafeScheduleFailure: CoreCall<RuntimeHostService["recordUnsafeScheduleFailure"]>;
  readonly querySync: (query: RuntimeQuery) => RuntimeQueryResult;
  readonly getSnapshotSync: () => RuntimeSnapshot;
  readonly observeSync: (observer: RuntimeObserver, nodeId?: NodeId) => RuntimeSubscription;
  readonly subscribeSignalsSync: (subscriber: RuntimeSignalSubscriber) => RuntimeSignalSubscription;
  /**
   * Resolves a node id without validating `request.args`. Only for a caller
   * that already ran `canonicalArgs(request.args)` on the same args.
   */
  readonly resolveValidatedNodeIdSync: (request: NodeRequest) => NodeId;
  /** True while graph jobs are queued and not yet run; the test harness waits on it. */
  readonly hasPendingJobsSync: () => boolean;
}
/**
 * Own, non-enumerable slot on a runtime built by `createRuntime` holding
 * its exact facade owner and `RuntimeCore.resolveValidatedNodeIdSync` as
 * `{ owner, resolve }`. Adapters reach it through the global symbol registry,
 * so it is not a package export; wrappers must match the owner by identity
 * before using the resolver, including a `Proxy` that forwards the slot.
 */
export const resolveValidatedNodeIdSlot: unique symbol = Symbol.for(
  "frond.runtime.resolveValidatedNodeIdSync"
) as never;
/**
 * The `RuntimeCore` of each host built by `makeRuntimeHost` and of the runtime
 * `bridgeRuntimeHost` makes from it, keyed by that exact object. A lookup reads
 * no property of its target, so a structural host never matches and a spread, a
 * prototype wrapper, or a `Proxy` is another key that keeps its own Effect or
 * Promise methods, with none of its traps run.
 */
const runtimeCores = new WeakMap<object, RuntimeCore>();
export function attachRuntimeCore(target: object, core: RuntimeCore): void {
  runtimeCores.set(target, core);
}
export function runtimeCore(target: object): RuntimeCore | undefined {
  return runtimeCores.get(target);
}
