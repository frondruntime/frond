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

export function readNode<TResult>(
  runtime: RuntimeReadHost,
  nodeId: NodeId
): RuntimeNodeRead<TResult> {
  return publicRuntimeNodeRead(readRawNode<TResult>(runtime, nodeId));
}

export function readRawNode<TResult>(
  runtime: RuntimeReadHost,
  nodeId: NodeId
): RawRuntimeNodeRead<TResult> {
  if (runtime.getStatusSync() === "stopped") {
    return unavailableRuntimeNodeRead(nodeId);
  }

  const nodeSnapshotLookup = runtime.readNodeSnapshotSync(
    nodeId
  ) as RuntimeNodeSnapshotLookup<TResult>;

  if (nodeSnapshotLookup._tag === "Missing") {
    return { _tag: "Unwired", nodeId };
  }

  const nodeSnapshot = nodeSnapshotLookup.snapshot;

  return Match.value(nodeSnapshot).pipe(
    Match.tag("Unwired", () => ({ _tag: "Unwired", nodeId }) satisfies RawRuntimeNodeRead<TResult>),
    Match.tag("Idle", (snapshot) => idleRuntimeNodeRead<TResult>(nodeId, snapshot)),
    Match.tag("Pending", (snapshot) => pendingRuntimeNodeRead<TResult>(nodeId, snapshot)),
    Match.tag("Ready", (snapshot) => readyRuntimeNodeRead<TResult>(nodeId, snapshot)),
    Match.tag("ReadinessError", (snapshot) =>
      errorRuntimeNodeRead<TResult>(nodeId, snapshot, snapshot.error)
    ),
    Match.tag("Releasing", (snapshot) => idleRuntimeNodeRead<TResult>(nodeId, snapshot)),
    Match.tag("Invalid", (snapshot) =>
      invalidRuntimeNodeRead<TResult>(nodeId, snapshot, snapshot.error)
    ),
    Match.exhaustive
  );
}

export function bootingRuntimeNodeRead<TResult>(
  nodeId: NodeId,
  attempt: Promise<NodeRead>
): RuntimeNodeRead<TResult> {
  return { _tag: "Pending", nodeId, attempt, operation: idleOperation, busy: false };
}

function publicRuntimeNodeRead<TResult>(
  read: RawRuntimeNodeRead<TResult>
): RuntimeNodeRead<TResult> {
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
        }) satisfies RuntimeNodeRead<TResult>
    ),
    Match.tag("Ready", (ready) => {
      if (ready.resultValidity._tag === "Expired") {
        return {
          _tag: "Idle",
          nodeId: ready.nodeId,
          operation: ready.operation,
          busy: ready.busy,
          operationFailure: ready.operationFailure,
        } satisfies RuntimeNodeRead<TResult>;
      }

      return {
        ...ready,
        resultValidity: ready.resultValidity,
      } satisfies RuntimeNodeRead<TResult>;
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
        }) satisfies RuntimeNodeRead<TResult>
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
        }) satisfies RuntimeNodeRead<TResult>
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
        }) satisfies RuntimeNodeRead<TResult>
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

function readyRuntimeNodeRead<TResult>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<unknown>, { readonly _tag: "Ready" }>
): RawRuntimeNodeRead<TResult> {
  const currentNode = nodeSnapshot.node;

  if (nodeSnapshot.resultValidity?._tag === "Expired") {
    return {
      _tag: "Expired",
      nodeId,
      resultValidity: nodeSnapshot.resultValidity,
      ...operationReadFields(nodeSnapshot),
    } satisfies RawRuntimeNodeRead<TResult>;
  }

  return {
    _tag: "Ready",
    nodeId,
    node: currentNode,
    result: nodeSnapshot.result as TResult | undefined,
    resultValidity: nodeSnapshot.resultValidity ?? { _tag: "Current" },
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult>;
}

function idleRuntimeNodeRead<TResult>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<unknown>, { readonly _tag: "Idle" | "Releasing" }>
): RawRuntimeNodeRead<TResult> {
  return {
    _tag: "Idle",
    nodeId,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult>;
}

function errorRuntimeNodeRead<TResult>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<unknown>, { readonly _tag: "ReadinessError" }>,
  error: unknown
): RawRuntimeNodeRead<TResult> {
  return {
    _tag: "Error",
    nodeId,
    error,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult>;
}

function invalidRuntimeNodeRead<TResult>(
  nodeId: NodeId,
  nodeSnapshot: RuntimeNodeSnapshot<unknown>,
  error: unknown
): RawRuntimeNodeRead<TResult> {
  return {
    _tag: "Invalid",
    nodeId,
    error,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult>;
}

function pendingRuntimeNodeRead<TResult>(
  nodeId: NodeId,
  nodeSnapshot: Extract<RuntimeNodeSnapshot<unknown>, { readonly _tag: "Pending" }>
): RawRuntimeNodeRead<TResult> {
  return {
    _tag: "Pending",
    nodeId,
    attempt: nodeSnapshot.attempt,
    ...operationReadFields(nodeSnapshot),
  } satisfies RawRuntimeNodeRead<TResult>;
}

function unavailableRuntimeNodeRead<TResult>(nodeId: NodeId): RawRuntimeNodeRead<TResult> {
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
