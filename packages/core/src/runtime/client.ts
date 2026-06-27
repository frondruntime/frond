import { GraphInvariantViolation, UpdateNodeArgsFailed } from "../graph";
import type { NodeId } from "../graph/types/ids";
import type { NodeLiveSource } from "../graph/types/liveness";
import type { ActionResult, EvictResult, RefreshResult } from "../graph/types/operations";
import type { NodeRead } from "../graph/types/reads";
import { FrondRuntimeInvariantViolation } from "./errors";
import { bootingRuntimeNodeRead, type RuntimeReadHost, readNode } from "./nodeRead";
import type {
  Runtime,
  RuntimeClient,
  RuntimeCommand,
  RuntimeNodeHandle,
  RuntimeNodeLiveLease,
  RuntimeNodeRead,
  RuntimeNodeSnapshotLookup,
  RuntimeSubmission,
  RuntimeWorkMetadata,
} from "./types";
import { createUnsafeRuntimeClient } from "./unsafeClient";
import { validateRuntimeWorkMetadata } from "./work";

type RuntimeClientHost = Pick<
  Runtime,
  "resolveNodeIdSync" | "readNodeSnapshot" | "observe" | "submit"
> &
  RuntimeReadHost;

export function createRuntimeClient(runtime: RuntimeClientHost): RuntimeClient {
  return {
    node: <TArgs, TResult>(spec: unknown, args: TArgs) =>
      createRuntimeNodeHandle<TArgs, TResult>(runtime, spec, args),
    __unsafe: createUnsafeRuntimeClient(runtime),
  };
}

function createRuntimeNodeHandle<TArgs, TResult>(
  runtime: RuntimeClientHost,
  spec: unknown,
  args: TArgs
): RuntimeNodeHandle<TArgs, TResult> {
  let currentArgs = args;
  const request = () => ({ spec, args: currentArgs });
  const nodeId = runtime.resolveNodeIdSync(request());
  const ensureReady = (
    metadata: RuntimeWorkMetadata | undefined = {
      source: "manual",
      reason: "readiness",
      priority: "visible",
    }
  ): Promise<NodeRead> => {
    return submitAndExtract(
      runtime,
      {
        _tag: "GraphEnsureReadyNode",
        request: request(),
        metadata,
      },
      "GraphNodeReadyEnsured",
      ({ read }) => read
    );
  };

  return {
    nodeId,
    get args() {
      return currentArgs;
    },
    read: () => readNode<TResult>(runtime, nodeId),
    boot: (metadata): RuntimeNodeRead<TResult> => {
      validateRuntimeWorkMetadata(metadata);
      const read = readNode<TResult>(runtime, nodeId);

      // Contract: boot may trigger only the first passive readiness attempt.
      // Existing pending/ready/error state is projected as-is for consumers.
      if (read._tag === "Unwired" || read._tag === "Idle") {
        return bootingRuntimeNodeRead(nodeId, settleBootAttempt(nodeId, ensureReady(metadata)));
      }

      return read;
    },
    subscribe: (listener) => {
      const subscription = runtime.observe((record) => {
        if (record.nodeIds.includes(nodeId)) {
          listener();
        }
      });

      return () => {
        subscription.unsubscribe();
      };
    },
    ensure: (metadata) => {
      return submitAndExtract(
        runtime,
        {
          _tag: "GraphEnsureNode",
          request: request(),
          metadata,
        },
        "GraphNodeEnsured",
        ({ read }) => read
      );
    },
    ensureReady,
    runAction: (action, input, metadata) => {
      return submitAndExtract(
        runtime,
        {
          _tag: "GraphRunAction",
          request: {
            target: {
              _tag: "NodeRequest",
              request: request(),
            },
            action,
            input,
          },
          metadata,
        },
        "GraphActionCompleted",
        ({ result }) => result
      );
    },
    refresh: (metadata) => {
      return submitAndExtract(
        runtime,
        {
          _tag: "GraphRefreshNode",
          request: {
            target: {
              _tag: "NodeRequest",
              request: request(),
            },
          },
          metadata,
        },
        "GraphRefreshCompleted",
        ({ result }) => result
      );
    },
    updateArgs: async (nextArgs, metadata) => {
      const nextNodeId = runtime.resolveNodeIdSync({ spec, args: nextArgs });

      if (nextNodeId !== nodeId) {
        return {
          _tag: "Failure",
          nodeId,
          error: new UpdateNodeArgsFailed({
            nodeId,
            tag: "unknown",
            cause: new GraphInvariantViolation({
              nodeId,
              tag: "unknown",
              invariant: "same-identity args update must resolve the current node id",
              cause: { currentNodeId: nodeId, nextNodeId },
            }),
          }),
        };
      }

      const result = await submitAndExtract(
        runtime,
        {
          _tag: "GraphUpdateNodeArgs",
          request: {
            nodeId,
            spec,
            args: nextArgs,
          },
          metadata,
        },
        "GraphNodeArgsUpdateCompleted",
        ({ result }) => result
      );

      if (result._tag === "Success") {
        currentArgs = nextArgs;
      }

      return result;
    },
    releaseResources: (reason, metadata) => {
      return submitAndExtract(
        runtime,
        {
          _tag: "GraphReleaseNode",
          nodeId,
          reason,
          metadata,
        },
        "GraphNodeReleased",
        () => undefined
      );
    },
    evict: (mode = "selfAndDependents", reason, metadata) => {
      return submitAndExtract(
        runtime,
        {
          _tag: "GraphEvictSubgraph",
          request: {
            rootNodeIds: [nodeId],
            mode,
            reason,
          },
          metadata,
        },
        "GraphSubgraphEvicted",
        ({ result }) => result
      );
    },
    acquireLiveLease: (source, scope, metadata) => {
      return submitAndExtract(
        runtime,
        {
          _tag: "GraphAcquireNodeLiveLease",
          request: {
            nodeId,
            source,
            scope,
          },
          metadata,
        },
        "GraphNodeLiveLeaseAcquired",
        ({ leaseId }) => makeRuntimeNodeLiveLease(runtime, nodeId, leaseId, source, scope)
      );
    },
    snapshot: async () => {
      return (await runtime.readNodeSnapshot(nodeId)) as RuntimeNodeSnapshotLookup<TResult>;
    },
  };
}

function makeRuntimeNodeLiveLease(
  runtime: RuntimeClientHost,
  nodeId: NodeId,
  leaseId: RuntimeNodeLiveLease["leaseId"],
  source: NodeLiveSource,
  scope: unknown
): RuntimeNodeLiveLease {
  let release: Promise<void> | undefined;
  let disposed = false;

  return {
    nodeId,
    leaseId,
    source,
    scope,
    dispose: async () => {
      if (disposed) {
        return;
      }

      if (release !== undefined) {
        return release;
      }

      release = submitAndExtract(
        runtime,
        {
          _tag: "GraphReleaseNodeLiveLease",
          request: {
            nodeId,
            leaseId,
          },
        },
        "GraphNodeLiveLeaseReleased",
        () => undefined
      ).then(
        () => {
          disposed = true;
        },
        (cause) => {
          release = undefined;
          throw cause;
        }
      );

      return release;
    },
  };
}

function settleBootAttempt(nodeId: NodeId, attempt: Promise<NodeRead>): Promise<NodeRead> {
  return attempt.catch(
    (cause) =>
      ({
        _tag: "Error",
        nodeId,
        status: { _tag: "Wired", run: { _tag: "Error", error: cause } },
        error: cause,
      }) satisfies NodeRead
  );
}

async function submitAndExtract<TTag extends RuntimeSubmission["_tag"], TResult>(
  runtime: Pick<RuntimeClientHost, "submit">,
  command: RuntimeCommand,
  expected: TTag,
  extract: (submission: Extract<RuntimeSubmission, { readonly _tag: TTag }>) => TResult
): Promise<TResult> {
  const submission = await runtime.submit(command);

  // Boundary: this is the client-side assertion that host submissions still
  // match the command protocol. A mismatch is a runtime invariant violation,
  // not a user-facing graph failure.
  if (submission._tag !== expected) {
    return unexpectedSubmission(expected, submission);
  }

  return extract(submission as Extract<RuntimeSubmission, { readonly _tag: TTag }>);
}

function unexpectedSubmission(expected: string, actual: unknown): never {
  throw new FrondRuntimeInvariantViolation({
    message: `Expected runtime submission ${expected}, received ${submissionTag(actual)}.`,
    cause: actual,
  });
}

function submissionTag(value: unknown): string {
  if (typeof value === "object" && value !== null && "_tag" in value) {
    return String(value._tag);
  }

  return "unknown";
}

export type RuntimeHandleResult<THandle> =
  THandle extends RuntimeNodeHandle<infer _TArgs, infer TResult> ? TResult : never;

export type { ActionResult, EvictResult, NodeRead, RefreshResult };
