import { Match } from "effect";
import type { NodeId, NodeRead } from "../graph";
import { idleOperation } from "../graph/operations/nodeOperation";
import { FrondRuntimeUnavailable } from "./errors";
import type {
  RawRuntimeNodeRead,
  Runtime,
  RuntimeNodeRead,
  RuntimeNodeSnapshot,
  RuntimeNodeSnapshotLookup,
} from "./types";

export type RuntimeReadHost = Pick<Runtime, "getStatusSync" | "readNodeSnapshotSync">;

export function readNode<TResult, TNode extends object = object>(
  runtime: RuntimeReadHost,
  nodeId: NodeId
): RuntimeNodeRead<TResult, TNode> {
  return publicRuntimeNodeRead(readRawNode<TResult, TNode>(runtime, nodeId));
}

/**
 * Reads the node's monotonic revision without materializing a read object.
 *
 * The revision bumps on every committed change to the node's cell state, so it
 * gives external stores an `Object.is`-stable snapshot for `useSyncExternalStore`
 * (`getSnapshot: handle.readVersion`) instead of hashing a fresh `read()` by hand.
 * A stopped runtime or an unwired node reports `0`.
 */
export function readNodeRevision(runtime: RuntimeReadHost, nodeId: NodeId): number {
  if (runtime.getStatusSync() === "stopped") {
    return 0;
  }

  const lookup = runtime.readNodeSnapshotSync(nodeId);

  return lookup._tag === "Missing" ? 0 : lookup.snapshot.revision;
}

export function readRawNode<TResult, TNode extends object = object>(
  runtime: RuntimeReadHost,
  nodeId: NodeId
): RawRuntimeNodeRead<TResult, TNode> {
  if (runtime.getStatusSync() === "stopped") {
    return unavailableRuntimeNodeRead(nodeId);
  }

  // Trust boundary: the typed handle that owns this nodeId vouches for the
  // node's result and instance types, exactly as it did for TResult alone.
  const nodeSnapshotLookup = runtime.readNodeSnapshotSync(nodeId) as RuntimeNodeSnapshotLookup<
    TResult,
    TNode
  >;

  if (nodeSnapshotLookup._tag === "Missing") {
    return { _tag: "Unwired", nodeId };
  }

  const nodeSnapshot = nodeSnapshotLookup.snapshot;

  return Match.value(nodeSnapshot).pipe(
    Match.tag(
      "Unwired",
      () => ({ _tag: "Unwired", nodeId }) satisfies RawRuntimeNodeRead<TResult, TNode>
    ),
    Match.tag("Idle", (snapshot) => idleRuntimeNodeRead<TResult, TNode>(nodeId, snapshot)),
    Match.tag("Pending", (snapshot) => pendingRuntimeNodeRead<TResult, TNode>(nodeId, snapshot)),
    Match.tag("Ready", (snapshot) => readyRuntimeNodeRead<TResult, TNode>(nodeId, snapshot)),
    Match.tag("ReadinessError", (snapshot) =>
      errorRuntimeNodeRead<TResult, TNode>(nodeId, snapshot, snapshot.error)
    ),
    Match.tag("Releasing", (snapshot) => idleRuntimeNodeRead<TResult, TNode>(nodeId, snapshot)),
    Match.tag("Invalid", (snapshot) =>
      invalidRuntimeNodeRead<TResult, TNode>(nodeId, snapshot, snapshot.error)
    ),
    Match.exhaustive
  );
}

export function bootingRuntimeNodeRead<TResult, TNode extends object = object>(
  nodeId: NodeId,
  attempt: Promise<NodeRead>
): RuntimeNodeRead<TResult, TNode> {
  return { _tag: "Pending", nodeId, attempt, operation: idleOperation, busy: false };
}

function publicRuntimeNodeRead<TResult, TNode extends object>(
  read: RawRuntimeNodeRead<TResult, TNode>
): RuntimeNodeRead<TResult, TNode> {
  return Match.value(read).pipe(
    Match.tag("Unwired", (unwired) => unwired),
    Match.tag("Idle", (idle) => idle),
    Match.tag("Pending", (pending) => pending),
    Match.tag(
      "Booting",
      ({ nodeId, attempt, operation, busy, operationFailure }) =>
        ({
          _tag: "Pending",
          nodeId,
          attempt,
          operation,
          busy,
          operationFailure,
        }) satisfies RuntimeNodeRead<TResult, TNode>
    ),
    Match.tag("Ready", (ready) => {
      if (ready.resultValidity._tag === "Expired") {
        return {
          _tag: "Idle",
          nodeId: ready.nodeId,
          operation: ready.operation,
          busy: ready.busy,
          operationFailure: ready.operationFailure,
        } satisfies RuntimeNodeRead<TResult, TNode>;
      }

      return {
        ...ready,
        resultValidity: ready.resultValidity,
      } satisfies RuntimeNodeRead<TResult, TNode>;
    }),
    Match.tag(
      "Expired",
      ({ nodeId, operation, busy, operationFailure }) =>
        ({
          _tag: "Idle",
          nodeId,
          operation,
          busy,
          operationFailure,
        }) satisfies RuntimeNodeRead<TResult, TNode>
    ),
    Match.tag("Error", (error) => ({ ...error, kind: "readiness" as const })),
    Match.tag(
      "Invalid",
      ({ nodeId, error, operation, busy, operationFailure }) =>
        ({
          _tag: "Error",
          nodeId,
          kind: "invalid" as const,
          error,
          operation,
          busy,
          operationFailure,
        }) satisfies RuntimeNodeRead<TResult, TNode>
    ),
    Match.tag(
      "Unavailable",
      ({ nodeId, error, operation, busy, operationFailure }) =>
        ({
          _tag: "Error",
          nodeId,
          kind: "runtime" as const,
          error,
          operation,
          busy,
          operationFailure,
        }) satisfies RuntimeNodeRead<TResult, TNode>
    ),
    Match.exhaustive
  );
}

function operationReadFields(snapshot: RuntimeNodeSnapshot<unknown>) {
  return {
    operation: snapshot.operation,
    busy: snapshot.operation._tag === "Running",
    operationFailure: snapshot.operationFailure,
  };
}

function readyRuntimeNodeRead<TResult, TNode extends object>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<TResult, TNode>, { readonly _tag: "Ready" }>
): RawRuntimeNodeRead<TResult, TNode> {
  const currentNode = nodeSnapshot.node;

  if (nodeSnapshot.resultValidity?._tag === "Expired") {
    return {
      _tag: "Expired",
      nodeId,
      resultValidity: nodeSnapshot.resultValidity,
      ...operationReadFields(nodeSnapshot),
    } satisfies RawRuntimeNodeRead<TResult, TNode>;
  }

  return {
    _tag: "Ready",
    nodeId,
    node: currentNode,
    result: nodeSnapshot.result,
    resultValidity: nodeSnapshot.resultValidity ?? { _tag: "Current" },
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult, TNode>;
}

function idleRuntimeNodeRead<TResult, TNode extends object>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<unknown>, { readonly _tag: "Idle" | "Releasing" }>
): RawRuntimeNodeRead<TResult, TNode> {
  return {
    _tag: "Idle",
    nodeId,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult, TNode>;
}

function errorRuntimeNodeRead<TResult, TNode extends object>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<unknown>, { readonly _tag: "ReadinessError" }>,
  error: unknown
): RawRuntimeNodeRead<TResult, TNode> {
  return {
    _tag: "Error",
    nodeId,
    error,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult, TNode>;
}

function invalidRuntimeNodeRead<TResult, TNode extends object>(
  nodeId: NodeId,
  nodeSnapshot: RuntimeNodeSnapshot<unknown>,
  error: unknown
): RawRuntimeNodeRead<TResult, TNode> {
  return {
    _tag: "Invalid",
    nodeId,
    error,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult, TNode>;
}

function pendingRuntimeNodeRead<TResult, TNode extends object>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<unknown>, { readonly _tag: "Pending" }>
): RawRuntimeNodeRead<TResult, TNode> {
  return {
    _tag: "Pending",
    nodeId,
    attempt: nodeSnapshot.attempt,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult, TNode>;
}

function unavailableRuntimeNodeRead<TResult, TNode extends object = object>(
  nodeId: NodeId
): RawRuntimeNodeRead<TResult, TNode> {
  return {
    _tag: "Unavailable",
    nodeId,
    error: new FrondRuntimeUnavailable({
      nodeId,
      message: `Frond runtime is stopped; node ${nodeId} cannot be read or booted.`,
    }),
    operation: idleOperation,
    busy: false,
  };
}
