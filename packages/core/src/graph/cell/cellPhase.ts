import type { Effect } from "effect";
import type { DisposerRegistry } from "../lifecycle/disposers";
import { idleOperation } from "../operations/nodeOperation";
import type { GraphCellTask } from "../queue/reply";
import type {
  ActiveNodeLiveDemandSnapshot,
  NodeLiveDemandSnapshot,
  NodeLiveFailure,
  NodeLiveLeaseId,
  NodeLiveScopeKey,
  NodeLiveSource,
  NodeObjectLookup,
  NodeOperation,
  NodeOperationFailure,
  NodeRead,
  NodeStatus,
  NormalizedResultValidityPolicy,
  ResultValidity,
} from "../types";

export type ActiveCellOperation = Extract<NodeOperation, { readonly _tag: "Running" }>;

export interface CellReadinessAttempt extends GraphCellTask<NodeRead> {
  readonly attemptId: number;
  readonly await: Effect.Effect<NodeRead>;
  readonly promise: Promise<NodeRead>;
  readonly resolve: (handle: NodeRead) => void;
}

export interface CellLiveLease {
  readonly leaseId: NodeLiveLeaseId;
  readonly source: NodeLiveSource;
  readonly scope: unknown;
  readonly scopeKey: NodeLiveScopeKey;
}

export interface CellBase {
  readonly previousResult?: { readonly result: unknown } | undefined;
  args: unknown;
  readonly liveLeases: ReadonlyArray<CellLiveLease>;
  readonly resultValidity?: ResultValidity | undefined;
  readonly liveFailure?: NodeLiveFailure | undefined;
}

export type LiveResourceState =
  | {
      readonly _tag: "Inactive";
    }
  | {
      readonly _tag: "Active";
      readonly generation: number;
      readonly demand: ActiveNodeLiveDemandSnapshot;
      readonly resource: unknown;
    };

export interface ReadyData extends CellBase {
  readonly node: object;
  deps: Readonly<Record<string, object>>;
  result: unknown;
  resultValidity: ResultValidity;
  resultLoadedAt?: number | undefined;
  readonly resultValidityPolicy: NormalizedResultValidityPolicy;
  // Ownership: the incarnation's disposer registry handed off by the acquire
  // operation bag. Later operation commits append into the same registry so
  // late adds through the bag and the teardown drain loop see one shared
  // once-only set. Internal-only: never projected into NodeSnapshot.
  readonly disposers: DisposerRegistry;
  readonly liveResource: LiveResourceState;
  // Owner: node-lifetime controller for this ready incarnation. Handed off by
  // the acquire commit; teardown aborts it exactly once when the node closes.
  readonly nodeLifetime: AbortController;
}

export type CellPhaseBaseLookup =
  | {
      readonly _tag: "Found";
      readonly base: CellBase;
    }
  | {
      readonly _tag: "Missing";
      readonly phase: "Invalid";
    };

export type CellPhaseReadyLookup =
  | {
      readonly _tag: "Found";
      readonly ready: ReadyData;
    }
  | {
      readonly _tag: "Missing";
      readonly phase: Exclude<CellPhase["_tag"], "Ready" | "Operating">;
    };

export type CellPhaseReadinessAttemptLookup =
  | {
      readonly _tag: "Found";
      readonly attempt: CellReadinessAttempt;
    }
  | {
      readonly _tag: "Missing";
      readonly phase: Exclude<CellPhase["_tag"], "Acquiring">;
    };

export type ProjectedFailure =
  | {
      readonly _tag: "None";
    }
  | {
      readonly _tag: "Present";
      readonly failure: unknown;
    };

interface CellPhaseProjectionBase {
  readonly status: NodeStatus;
  readonly args: unknown;
  readonly resultValidity?: ResultValidity | undefined;
  readonly failure: ProjectedFailure;
  readonly liveDemand: NodeLiveDemandSnapshot;
  readonly liveFailure?: NodeLiveFailure | undefined;
  readonly operation: NodeOperation;
  readonly operationFailure?: NodeOperationFailure | undefined;
}

export type CellPhase =
  | {
      readonly _tag: "Idle";
      readonly base: CellBase;
      readonly cleanupFailure?: unknown | undefined;
    }
  | {
      readonly _tag: "Acquiring";
      readonly base: CellBase;
      readonly attempt: CellReadinessAttempt;
    }
  | {
      readonly _tag: "ReadinessError";
      readonly base: CellBase;
      readonly error: unknown;
    }
  | {
      readonly _tag: "Ready";
      readonly ready: ReadyData;
      readonly operationFailure?: NodeOperationFailure | undefined;
    }
  | {
      readonly _tag: "Operating";
      readonly ready: ReadyData;
      readonly operation: ActiveCellOperation;
    }
  | {
      readonly _tag: "Invalid";
      readonly base?: CellBase | undefined;
      readonly error: unknown;
    };

export type CellPhaseProjection =
  | ({
      readonly _tag: "Idle";
    } & CellPhaseProjectionBase)
  | ({
      readonly _tag: "Pending";
      readonly attempt: Promise<NodeRead>;
    } & CellPhaseProjectionBase)
  | ({
      readonly _tag: "ReadinessError";
    } & CellPhaseProjectionBase)
  | ({
      readonly _tag: "Ready";
      readonly result: unknown;
      readonly node: object;
    } & CellPhaseProjectionBase)
  | {
      readonly _tag: "Invalid";
      readonly status: Extract<NodeStatus, { readonly _tag: "Invalid" }>;
      readonly nodeLookup: NodeObjectLookup;
      readonly args?: unknown | undefined;
      readonly resultValidity?: ResultValidity | undefined;
      readonly failure: ProjectedFailure;
      readonly liveDemand: NodeLiveDemandSnapshot;
      readonly liveFailure?: NodeLiveFailure | undefined;
      readonly operation: NodeOperation;
      readonly operationFailure?: NodeOperationFailure | undefined;
    }
  | {
      readonly _tag: "Removed";
      readonly reason?: string | undefined;
    };

export function idleCell(base: CellBase, cleanupFailure?: unknown | undefined): CellPhase {
  return { _tag: "Idle", base, cleanupFailure };
}

export function acquiringCell(base: CellBase, attempt: CellReadinessAttempt): CellPhase {
  return { _tag: "Acquiring", base, attempt };
}

export function readinessErrorCell(base: CellBase, error: unknown): CellPhase {
  return { _tag: "ReadinessError", base, error };
}

export function readyCell(
  ready: ReadyData,
  operationFailure?: NodeOperationFailure | undefined
): CellPhase {
  return { _tag: "Ready", ready, operationFailure };
}

export function operatingCell(ready: ReadyData, operation: ActiveCellOperation): CellPhase {
  return { _tag: "Operating", ready, operation };
}

export function invalidCell(error: unknown, base?: CellBase | undefined): CellPhase {
  return { _tag: "Invalid", base, error };
}

export function projectCellPhase(phase: CellPhase): CellPhaseProjection {
  switch (phase._tag) {
    case "Idle": {
      const { base, cleanupFailure } = phase;
      return projectedBase("Idle", base, { _tag: "Wired", run: { _tag: "Idle" } }, cleanupFailure);
    }
    case "Acquiring": {
      const { base, attempt } = phase;
      return projectedAcquiring(
        base,
        {
          _tag: "Wired",
          run: { _tag: "Pending", attemptId: attempt.attemptId },
        },
        attempt
      );
    }
    case "ReadinessError": {
      const { base, error } = phase;
      return projectedBase(
        "ReadinessError",
        base,
        { _tag: "Wired", run: { _tag: "Error", error } },
        error
      );
    }
    case "Ready": {
      const { ready, operationFailure } = phase;
      return projectedReady(ready, idleOperation, operationFailure);
    }
    case "Operating": {
      const { ready, operation } = phase;
      return projectedReady(ready, operation, undefined);
    }
    case "Invalid": {
      const { base, error } = phase;
      return projectedInvalid(error, base);
    }
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function phaseArgs(phase: CellPhase): unknown {
  const lookup = phaseBase(phase);

  return lookup._tag === "Found" ? lookup.base.args : undefined;
}

export function phaseReadyData(phase: CellPhase): CellPhaseReadyLookup {
  switch (phase._tag) {
    case "Idle": {
      return { _tag: "Missing", phase: "Idle" } as const;
    }
    case "Acquiring": {
      return { _tag: "Missing", phase: "Acquiring" } as const;
    }
    case "ReadinessError": {
      return { _tag: "Missing", phase: "ReadinessError" } as const;
    }
    case "Ready": {
      const { ready } = phase;
      return { _tag: "Found", ready } as const;
    }
    case "Operating": {
      const { ready } = phase;
      return { _tag: "Found", ready } as const;
    }
    case "Invalid": {
      return { _tag: "Missing", phase: "Invalid" } as const;
    }
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function phaseBase(phase: CellPhase): CellPhaseBaseLookup {
  switch (phase._tag) {
    case "Idle": {
      const { base } = phase;
      return { _tag: "Found", base } as const;
    }
    case "Acquiring": {
      const { base } = phase;
      return { _tag: "Found", base } as const;
    }
    case "ReadinessError": {
      const { base } = phase;
      return { _tag: "Found", base } as const;
    }
    case "Ready": {
      const { ready } = phase;
      return { _tag: "Found", base: cellBaseFromReady(ready) } as const;
    }
    case "Operating": {
      const { ready } = phase;
      return { _tag: "Found", base: cellBaseFromReady(ready) } as const;
    }
    case "Invalid": {
      const { base } = phase;
      return base === undefined
        ? ({ _tag: "Missing", phase: "Invalid" } as const)
        : ({ _tag: "Found", base } as const);
    }
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function phaseLiveLeases(phase: CellPhase): ReadonlyArray<CellLiveLease> {
  const lookup = phaseBase(phase);

  return lookup._tag === "Found" ? lookup.base.liveLeases : [];
}

export function phaseReadinessAttempt(phase: CellPhase): CellPhaseReadinessAttemptLookup {
  switch (phase._tag) {
    case "Idle": {
      return { _tag: "Missing", phase: "Idle" } as const;
    }
    case "Acquiring": {
      const { attempt } = phase;
      return { _tag: "Found", attempt } as const;
    }
    case "ReadinessError": {
      return { _tag: "Missing", phase: "ReadinessError" } as const;
    }
    case "Ready": {
      return { _tag: "Missing", phase: "Ready" } as const;
    }
    case "Operating": {
      return { _tag: "Missing", phase: "Operating" } as const;
    }
    case "Invalid": {
      return { _tag: "Missing", phase: "Invalid" } as const;
    }
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function mapPhaseBase(phase: CellPhase, map: (base: CellBase) => CellBase): CellPhase {
  switch (phase._tag) {
    case "Idle": {
      const { base, cleanupFailure } = phase;
      return idleCell(map(base), cleanupFailure);
    }
    case "Acquiring": {
      const { base, attempt } = phase;
      return acquiringCell(map(base), attempt);
    }
    case "ReadinessError": {
      const { base, error } = phase;
      return readinessErrorCell(map(base), error);
    }
    case "Ready": {
      const { ready, operationFailure } = phase;
      return readyCell(mapReadyBase(ready, map), operationFailure);
    }
    case "Operating": {
      const { ready, operation } = phase;
      return operatingCell(mapReadyBase(ready, map), operation);
    }
    case "Invalid": {
      const { base, error } = phase;
      return invalidCell(error, base === undefined ? undefined : map(base));
    }
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function mapPhaseReady(phase: CellPhase, map: (ready: ReadyData) => ReadyData): CellPhase {
  switch (phase._tag) {
    case "Ready": {
      const { ready, operationFailure } = phase;
      return readyCell(map(ready), operationFailure);
    }
    case "Operating": {
      const { ready, operation } = phase;
      return operatingCell(map(ready), operation);
    }
    default: {
      return phase;
    }
  }
}

const INACTIVE_LIVE_DEMAND: NodeLiveDemandSnapshot = Object.freeze({
  isLive: false,
  sources: Object.freeze([]) as ReadonlyArray<NodeLiveSource>,
  scopes: Object.freeze([]) as ReadonlyArray<unknown>,
});
const NO_PROJECTED_FAILURE: ProjectedFailure = Object.freeze({ _tag: "None" });
const MISSING_NODE_LOOKUP: NodeObjectLookup = Object.freeze({ _tag: "Missing" });

export function projectLiveDemand(
  leases: ReadonlyArray<Pick<CellLiveLease, "source" | "scope" | "scopeKey">>
): NodeLiveDemandSnapshot {
  // The common idle case has no leases; avoid building Sets/Maps and return a
  // shared frozen inactive snapshot.
  if (leases.length === 0) {
    return INACTIVE_LIVE_DEMAND;
  }

  if (leases.length === 1) {
    const [lease] = leases;

    if (lease === undefined) {
      return INACTIVE_LIVE_DEMAND;
    }

    return {
      isLive: true,
      sources: [lease.source],
      scopes: [lease.scope],
    };
  }

  const sourcesSet = new Set<NodeLiveSource>();
  const scopesByKey = new Map<NodeLiveScopeKey, unknown>();

  for (const lease of leases) {
    sourcesSet.add(lease.source);

    if (!scopesByKey.has(lease.scopeKey)) {
      scopesByKey.set(lease.scopeKey, lease.scope);
    }
  }

  return {
    isLive: scopesByKey.size > 0,
    sources: [...sourcesSet].sort(),
    scopes: [...scopesByKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, scope]) => scope),
  };
}

export function activeLiveDemand(demand: NodeLiveDemandSnapshot):
  | {
      readonly _tag: "Active";
      readonly demand: ActiveNodeLiveDemandSnapshot;
    }
  | {
      readonly _tag: "Inactive";
      readonly demand: NodeLiveDemandSnapshot;
    } {
  return demand.isLive && demand.sources.length > 0 && demand.scopes.length > 0
    ? {
        _tag: "Active",
        demand: {
          isLive: true,
          sources: demand.sources as readonly [NodeLiveSource, ...NodeLiveSource[]],
          scopes: demand.scopes as readonly [unknown, ...unknown[]],
        },
      }
    : { _tag: "Inactive", demand };
}

function projectedBase(
  tag: "Idle" | "ReadinessError",
  base: CellBase,
  status: NodeStatus,
  failure?: unknown | undefined
): CellPhaseProjection {
  return {
    _tag: tag,
    status,
    args: base.args,
    resultValidity: base.resultValidity,
    failure: projectedFailure(failure),
    liveDemand: projectLiveDemand(base.liveLeases),
    liveFailure: base.liveFailure,
    operation: idleOperation,
  };
}

function projectedAcquiring(
  base: CellBase,
  status: NodeStatus,
  attempt: CellReadinessAttempt
): CellPhaseProjection {
  return {
    _tag: "Pending",
    status,
    args: base.args,
    resultValidity: base.resultValidity,
    failure: NO_PROJECTED_FAILURE,
    liveDemand: projectLiveDemand(base.liveLeases),
    liveFailure: base.liveFailure,
    operation: idleOperation,
    attempt: attempt.promise,
  };
}

function projectedReady(
  ready: ReadyData,
  operation: NodeOperation,
  operationFailure: NodeOperationFailure | undefined
): CellPhaseProjection {
  return {
    _tag: "Ready",
    status: { _tag: "Wired", run: { _tag: "Ready" } },
    node: ready.node,
    args: ready.args,
    result: ready.result,
    resultValidity: ready.resultValidity,
    failure: NO_PROJECTED_FAILURE,
    liveDemand: projectLiveDemand(ready.liveLeases),
    liveFailure: ready.liveFailure,
    operation,
    operationFailure,
  };
}

function mapReadyBase(ready: ReadyData, map: (base: CellBase) => CellBase): ReadyData {
  const nextBase = map(cellBaseFromReady(ready));
  return {
    ...ready,
    args: nextBase.args,
    liveLeases: nextBase.liveLeases,
    liveFailure: nextBase.liveFailure,
    resultValidity: nextBase.resultValidity ?? ready.resultValidity,
  };
}

function cellBaseFromReady(ready: ReadyData): CellBase {
  return {
    args: ready.args,
    liveLeases: ready.liveLeases,
    resultValidity: ready.resultValidity,
    liveFailure: ready.liveFailure,
  };
}

function projectedInvalid(error: unknown, base: CellBase | undefined): CellPhaseProjection {
  return {
    _tag: "Invalid",
    status: { _tag: "Invalid", error },
    nodeLookup: MISSING_NODE_LOOKUP,
    args: base?.args,
    resultValidity: base?.resultValidity,
    failure: projectedFailure(error),
    liveDemand: projectLiveDemand(base?.liveLeases ?? []),
    liveFailure: base?.liveFailure,
    operation: idleOperation,
  };
}

function projectedFailure(failure: unknown | undefined): ProjectedFailure {
  return failure === undefined ? NO_PROJECTED_FAILURE : { _tag: "Present", failure };
}
