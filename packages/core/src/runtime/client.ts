import { Effect } from "effect";
import { type ActionContracts, type DriverMode, recoverDriverMode } from "../driver/types";
import { GraphInvariantViolation, UpdateNodeArgsFailed } from "../graph";
import type { NodeId } from "../graph/types/ids";
import type { NodeLiveSource } from "../graph/types/liveness";
import type { ActionResult, EvictResult, RefreshResult } from "../graph/types/operations";
import type { NodeRead } from "../graph/types/reads";
import { isKeyError } from "../keys";
import { PROTOCOL_PROPERTY_NAMES } from "../node/runtime";
import type {
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecLike,
  NodeSpecMode,
  NodeSpecResult,
} from "../node/types";
import { coreOf, expectSubmission, interruptOnSignal, type RuntimeClientCore } from "./clientCore";
import { FrondNodeNotReady, type FrondNodeReadiness } from "./errors";
import { bootingRuntimeNodeRead, readNode, readNodeRevision } from "./nodeRead";
import type {
  HandleActions,
  RuntimeClient,
  RuntimeCommand,
  RuntimeError,
  RuntimeHandleNode,
  RuntimeHostService,
  RuntimeNodeHandle,
  RuntimeNodeLiveLease,
  RuntimeNodeLiveLeaseResult,
  RuntimeNodeRead,
  RuntimeNodeSnapshotLookup,
  RuntimeSubmission,
  RuntimeWorkMetadata,
} from "./types";
import { createUnsafeRuntimeClient } from "./unsafeClient";
import { validateRuntimeWorkMetadata } from "./work";

/** Fallback runner for externally supplied Effect hosts and test doubles. */
export interface RuntimeEffectBridgeRunner {
  readonly run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  readonly runSync: <A>(effect: Effect.Effect<A, unknown>) => A;
}

/** Public Effect surface; a host from `makeRuntimeHost` also carries its callback core. */
export type RuntimeClientHost = Pick<
  RuntimeHostService,
  | "resolveNodeIdSync"
  | "getStatusSync"
  | "readNodeSnapshotSync"
  | "readNodeRevisionSync"
  | "readNodeSnapshot"
  | "submit"
  | "observe"
>;

export function createRuntimeClient(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner
): RuntimeClient {
  const core = coreOf(host, runner);
  return {
    node: <TSpec extends NodeSpecLike>(spec: TSpec, args: NodeSpecArgs<TSpec>) =>
      createRuntimeNodeHandle<NodeSpecArgs<TSpec>, NodeSpecResult<TSpec>, RuntimeHandleNode<TSpec>>(
        host,
        core,
        spec,
        args
      ) as RuntimeNodeHandle<
        NodeSpecArgs<TSpec>,
        NodeSpecResult<TSpec>,
        NodeSpecActions<TSpec>,
        NodeSpecMode<TSpec>,
        RuntimeHandleNode<TSpec>
      >,
    __unsafe: createUnsafeRuntimeClient(host, core),
  };
}

function createRuntimeNodeHandle<TArgs, TResult, TNode extends object = object>(
  host: RuntimeClientHost,
  core: RuntimeClientCore,
  spec: unknown,
  args: TArgs
): RuntimeNodeHandle<TArgs, TResult, Record<string, never>, "async", TNode> {
  let currentArgs = args;
  // Args updates through this handle commit in call order (one plan queue,
  // then per-cell FIFO), but their replies wait on event sinks and can arrive
  // out of that order. A reply applies only when it is newer than the last
  // applied one, so the handle never moves back to an older commit.
  let argsUpdatesIssued = 0;
  let argsUpdateApplied = 0;
  const applyArgsUpdate = (sequence: number, nextArgs: TArgs): void => {
    if (sequence < argsUpdateApplied) return;
    argsUpdateApplied = sequence;
    currentArgs = nextArgs;
  };
  const request = () => ({ spec, args: currentArgs });
  const nodeId = host.resolveNodeIdSync(request());

  // Both facades submit to the same queue-backed core.
  const submit = <TTag extends RuntimeSubmission["_tag"], TValue>(
    command: RuntimeCommand,
    expected: TTag,
    extract: (submission: Extract<RuntimeSubmission, { readonly _tag: TTag }>) => TValue
  ): Promise<TValue> => submitPromise(core, command, expected, extract);

  const ensureReady = (
    metadata: RuntimeWorkMetadata | undefined = readinessMetadata
  ): Promise<NodeRead> => {
    validateRuntimeWorkMetadata(metadata);
    return submitPromise(
      core,
      { _tag: "GraphEnsureReadyNode", request: request(), metadata },
      "GraphNodeReadyEnsured",
      ({ read }) => read
    );
  };

  // Ready-or-throw projection of the same sync read `read()` performs: Ready
  // yields the typed node, Error rethrows the read's error, and the remaining
  // phases throw `FrondNodeNotReady` with the observed readiness. Sync-only:
  // never schedules graph work.
  const readReady = (): TNode => {
    const read = readNode<TResult, TNode>(host, nodeId);

    switch (read._tag) {
      case "Ready":
        return read.node;
      case "Error":
        throw read.error;
      case "Unwired":
      case "Idle":
      case "Pending":
        // The tag rides on the same read that decided to throw, so the error
        // is atomic with that read — no second snapshot lookup.
        throw new FrondNodeNotReady({
          nodeId,
          tag: read.tag,
          readiness: notReadyReadiness(read._tag),
        });
      default: {
        const exhaustive: never = read;
        return exhaustive;
      }
    }
  };

  return {
    nodeId,
    get args() {
      return currentArgs;
    },
    read: () => readNode<TResult, TNode>(host, nodeId),
    readVersion: () => readNodeRevision(host, nodeId),
    boot: (metadata): RuntimeNodeRead<TResult, TNode> => {
      validateRuntimeWorkMetadata(metadata);
      const read = readNode<TResult, TNode>(host, nodeId);

      // Contract: boot may trigger only the first passive readiness attempt.
      // Existing pending/ready/error state is projected as-is for consumers.
      if (read._tag === "Unwired" || read._tag === "Idle") {
        const attempt = core.submitPromise(
          {
            _tag: "GraphEnsureReadyNode",
            request: request(),
            metadata: metadata ?? readinessMetadata,
          },
          readySubmission,
          (cause) => failedBootRead(nodeId, cause)
        );
        return bootingRuntimeNodeRead<TResult, TNode>(nodeId, attempt, read.tag);
      }

      return read;
    },
    subscribe: (listener) => {
      const onRecord: Parameters<RuntimeHostService["observe"]>[0] = (record) => {
        if (record.nodeIds.includes(nodeId)) listener();
      };
      const subscription = core.observeSync(onRecord, nodeId);

      return () => {
        subscription.unsubscribe();
      };
    },
    ensure: (metadata) =>
      submit(
        { _tag: "GraphEnsureNode", request: request(), metadata },
        "GraphNodeEnsured",
        ({ read }) => read
      ),
    ensureReady,
    readReady,
    ensureReadyNode: (metadata) =>
      submitPromise(
        core,
        {
          _tag: "GraphEnsureReadyNode",
          request: request(),
          metadata: metadata ?? readinessMetadata,
        },
        "GraphNodeReadyEnsured",
        readReady
      ),
    // Mirror the type-level `NodeSpecMode` via the shared mode recovery, so a
    // bare effect-mode descriptor dispatches Effect-native actions instead of
    // silently degrading to the Promise projection.
    actions: makeHandleActions(host, core, request, recoverDriverMode(spec)),
    action: (action, input, metadata) => {
      // Same synchronous fail-fast as `boot`: invalid metadata (including a
      // non-AbortSignal `signal`) throws before any Effect is constructed.
      validateRuntimeWorkMetadata(metadata);

      const effect = submitEffect(
        host,
        runActionCommand(request(), action, input, metadata),
        "GraphActionCompleted",
        ({ result }) => result
      );

      return metadata?.signal === undefined ? effect : interruptOnSignal(effect, metadata.signal);
    },
    refresh: (metadata) =>
      submit(
        {
          _tag: "GraphRefreshNode",
          request: { target: { _tag: "NodeRequest", request: request() } },
          metadata,
        },
        "GraphRefreshCompleted",
        ({ result }) => result
      ),
    updateArgs: (nextArgs, metadata) => {
      let nextNodeId: NodeId;

      try {
        nextNodeId = host.resolveNodeIdSync({ spec, args: nextArgs });
      } catch (cause) {
        if (!isKeyError(cause)) {
          return Promise.reject(cause);
        }

        return Promise.resolve({
          _tag: "Failure" as const,
          nodeId,
          error: new UpdateNodeArgsFailed({
            nodeId,
            tag: "unknown",
            cause,
          }),
        });
      }

      if (nextNodeId !== nodeId) {
        return Promise.resolve({
          _tag: "Failure" as const,
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
        });
      }

      const command: RuntimeCommand = {
        _tag: "GraphUpdateNodeArgs",
        request: { nodeId, spec, args: nextArgs },
        metadata,
      };
      argsUpdatesIssued += 1;
      const sequence = argsUpdatesIssued;
      validateRuntimeWorkMetadata(metadata);
      // The handle follows the commit: on a host with a core, an aborted caller
      // still sees the args it submitted once the update commits.
      return core.submitPromise(command, argsUpdateResult, undefined, (submission) => {
        if (
          submission._tag === "GraphNodeArgsUpdateCompleted" &&
          submission.result._tag === "Success"
        )
          applyArgsUpdate(sequence, nextArgs);
      });
    },
    releaseResources: (reason, metadata) =>
      submit(
        { _tag: "GraphReleaseNode", nodeId, reason, metadata },
        "GraphNodeReleased",
        () => undefined
      ),
    evict: (mode = "selfAndDependents", reason, metadata) =>
      submit(
        {
          _tag: "GraphEvictSubgraph",
          request: { rootNodeIds: [nodeId], mode, reason },
          metadata,
        },
        "GraphSubgraphEvicted",
        ({ result }) => result
      ),
    acquireLiveLease: (source, scope, metadata) =>
      submit(
        {
          _tag: "GraphAcquireNodeLiveLease",
          request: { nodeId, source, scope },
          metadata,
        },
        "GraphNodeLiveLeaseAcquired",
        ({ result }) => {
          switch (result._tag) {
            case "Held":
              return {
                _tag: "Held",
                nodeId: result.nodeId,
                lease: makeRuntimeNodeLiveLease(core, result.nodeId, result.leaseId, source, scope),
                liveDemand: result.liveDemand,
              } satisfies RuntimeNodeLiveLeaseResult;
            case "Failed":
              return {
                _tag: "Failure",
                nodeId: result.nodeId,
                failures: result.failures,
                liveDemand: result.liveDemand,
              } satisfies RuntimeNodeLiveLeaseResult;
            case "NodeMissing":
              return {
                _tag: "NodeMissing",
                nodeId: result.nodeId,
                liveDemand: result.liveDemand,
              } satisfies RuntimeNodeLiveLeaseResult;
            default: {
              const exhaustive: never = result;
              return exhaustive;
            }
          }
        }
      ),
    snapshot: () =>
      core.readNodeSnapshot(nodeId) as Promise<RuntimeNodeSnapshotLookup<TResult, TNode>>,
  };
}

function makeRuntimeNodeLiveLease(
  core: RuntimeClientCore,
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

      release = submitPromise(
        core,
        { _tag: "GraphReleaseNodeLiveLease", request: { nodeId, leaseId } },
        "GraphNodeLiveLeaseReleased",
        voidResult
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

function notReadyReadiness(tag: "Unwired" | "Idle" | "Pending"): FrondNodeReadiness {
  switch (tag) {
    case "Unwired":
      return "unwired";
    case "Idle":
      return "idle";
    case "Pending":
      return "pending";
    default: {
      const exhaustive: never = tag;
      return exhaustive;
    }
  }
}

function failedBootRead(nodeId: NodeId, cause: unknown): NodeRead {
  return {
    _tag: "Error",
    nodeId,
    status: { _tag: "Wired", run: { _tag: "Error", error: cause } },
    error: cause,
  };
}

function readySubmission(submission: RuntimeSubmission): NodeRead {
  return expectSubmission(submission, "GraphNodeReadyEnsured").read;
}

function makeHandleActions(
  host: RuntimeClientHost,
  core: RuntimeClientCore,
  request: () => { readonly spec: unknown; readonly args: unknown },
  mode: DriverMode
): HandleActions<ActionContracts, DriverMode> {
  // Dispatch the same runtime action as the untyped primitive, but present it in
  // the node's authored mode: effect nodes get the Effect, async nodes get its
  // Promise projection. Protocol trap names read as undefined so the facade is
  // never mistaken for a thenable. The trap-name set is shared with the node
  // facade proxy, but the dispatch policies intentionally differ: this handle
  // proxy dispatches ANY non-protocol name, while the node facade dispatches
  // declared action names only.
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string" || PROTOCOL_PROPERTY_NAMES.has(property)) {
        return undefined;
      }

      return (...input: ReadonlyArray<unknown>) => {
        const command = runActionCommand(request(), property, input[0], undefined);
        return mode === "effect"
          ? submitEffect(host, command, "GraphActionCompleted", actionResult)
          : submitPromise(core, command, "GraphActionCompleted", actionResult);
      };
    },
  }) as HandleActions<ActionContracts, DriverMode>;
}

function runActionCommand(
  nodeRequest: { readonly spec: unknown; readonly args: unknown },
  action: string,
  input: unknown,
  metadata: RuntimeWorkMetadata | undefined
): RuntimeCommand {
  return {
    _tag: "GraphRunAction",
    request: {
      target: {
        _tag: "NodeRequest",
        request: nodeRequest,
      },
      action,
      input,
    },
    metadata,
  };
}

/**
 * The client's single submit path: submit the command Effect-natively and assert
 * the returned submission matches the command protocol.
 *
 * A tag mismatch is a runtime invariant violation, not a user-facing graph
 * failure, so it surfaces as an Effect defect (the thrown error) rather than the
 * typed `RuntimeError` channel.
 */
function submitEffect<TTag extends RuntimeSubmission["_tag"], TResult>(
  host: Pick<RuntimeClientHost, "submit">,
  command: RuntimeCommand,
  expected: TTag,
  extract: (submission: Extract<RuntimeSubmission, { readonly _tag: TTag }>) => TResult
): Effect.Effect<TResult, RuntimeError> {
  return host
    .submit(command)
    .pipe(Effect.map((submission) => extract(expectSubmission(submission, expected))));
}

export type RuntimeHandleResult<THandle> =
  THandle extends RuntimeNodeHandle<infer _TArgs, infer TResult> ? TResult : never;

export type { ActionResult, EvictResult, NodeRead, RefreshResult };

function submitPromise<TTag extends RuntimeSubmission["_tag"], TResult>(
  core: RuntimeClientCore,
  command: RuntimeCommand,
  expected: TTag,
  extract: (submission: Extract<RuntimeSubmission, { readonly _tag: TTag }>) => TResult
): Promise<TResult> {
  validateRuntimeWorkMetadata(command.metadata);
  return core.submitPromise(command, (submission) =>
    extract(expectSubmission(submission, expected))
  );
}
const argsUpdateResult = (submission: RuntimeSubmission) =>
  expectSubmission(submission, "GraphNodeArgsUpdateCompleted").result;
const actionResult = (
  submission: Extract<RuntimeSubmission, { readonly _tag: "GraphActionCompleted" }>
) => submission.result;
const voidResult = () => undefined;

const readinessMetadata = { source: "manual", reason: "readiness", priority: "visible" } as const;
