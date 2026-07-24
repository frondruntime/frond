import { Effect } from "effect";
import type { ActionContracts, DriverMode } from "../driver/types";
import { GraphInvariantViolation, UpdateNodeArgsFailed } from "../graph";
import type { NodeId } from "../graph/types/ids";
import type { NodeLiveSource } from "../graph/types/liveness";
import type { ActionResult, EvictResult, RefreshResult } from "../graph/types/operations";
import type { NodeRead } from "../graph/types/reads";
import { isKeyError } from "../keys";
import type {
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecLike,
  NodeSpecMode,
  NodeSpecResult,
} from "../node/types";
import { FrondRuntimeInvariantViolation } from "./errors";
import { bootingRuntimeNodeRead, readNode, readNodeRevision } from "./nodeRead";
import type {
  HandleActions,
  RuntimeClient,
  RuntimeCommand,
  RuntimeError,
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

/**
 * Bridges Effect-native host work to Promise/sync callers.
 *
 * The client is Effect-native at its core: every handle operation is an Effect
 * over the runtime host. The runner is how the client derives its Promise
 * surface — the `.async` action channel and the Promise-returning handle
 * methods — so Effect is the primitive and Promise is the projection, never the
 * other way around.
 */
export interface RuntimeEffectBridgeRunner {
  readonly run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  readonly runSync: <A>(effect: Effect.Effect<A, unknown>) => A;
}

/**
 * Effect-native host surface the client is built over.
 *
 * Intentionally the host service, not the Promise `Runtime` facade: node handles
 * own their own Effect→Promise bridging, so the effect action channel reaches
 * the same submit the async channel does.
 */
export type RuntimeClientHost = Pick<
  RuntimeHostService,
  | "resolveNodeIdSync"
  | "getStatusSync"
  | "readNodeSnapshotSync"
  | "readNodeSnapshot"
  | "submit"
  | "observe"
>;

export function createRuntimeClient(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner
): RuntimeClient {
  return {
    node: <TSpec extends NodeSpecLike>(spec: TSpec, args: NodeSpecArgs<TSpec>) =>
      createRuntimeNodeHandle<NodeSpecArgs<TSpec>, NodeSpecResult<TSpec>>(
        host,
        runner,
        spec,
        args
      ) as RuntimeNodeHandle<
        NodeSpecArgs<TSpec>,
        NodeSpecResult<TSpec>,
        NodeSpecActions<TSpec>,
        NodeSpecMode<TSpec>
      >,
    __unsafe: createUnsafeRuntimeClient(host, runner),
  };
}

function createRuntimeNodeHandle<TArgs, TResult>(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner,
  spec: unknown,
  args: TArgs
): RuntimeNodeHandle<TArgs, TResult> {
  let currentArgs = args;
  const request = () => ({ spec, args: currentArgs });
  const nodeId = host.resolveNodeIdSync(request());

  // Every Promise-returning handle method is the one Effect submit run through
  // the bridge. There is a single submit path; the Promise surface is its
  // projection.
  const submit = <TTag extends RuntimeSubmission["_tag"], TValue>(
    command: RuntimeCommand,
    expected: TTag,
    extract: (submission: Extract<RuntimeSubmission, { readonly _tag: TTag }>) => TValue
  ): Promise<TValue> => runner.run(submitEffect(host, command, expected, extract));

  const ensureReady = (
    metadata: RuntimeWorkMetadata | undefined = {
      source: "manual",
      reason: "readiness",
      priority: "visible",
    }
  ): Promise<NodeRead> =>
    submit(
      { _tag: "GraphEnsureReadyNode", request: request(), metadata },
      "GraphNodeReadyEnsured",
      ({ read }) => read
    );

  return {
    nodeId,
    get args() {
      return currentArgs;
    },
    read: () => readNode<TResult>(host, nodeId),
    readVersion: () => readNodeRevision(host, nodeId),
    boot: (metadata): RuntimeNodeRead<TResult> => {
      validateRuntimeWorkMetadata(metadata);
      const read = readNode<TResult>(host, nodeId);

      // Contract: boot may trigger only the first passive readiness attempt.
      // Existing pending/ready/error state is projected as-is for consumers.
      if (read._tag === "Unwired" || read._tag === "Idle") {
        return bootingRuntimeNodeRead(nodeId, settleBootAttempt(nodeId, ensureReady(metadata)));
      }

      return read;
    },
    subscribe: (listener) => {
      const subscription = runner.runSync(
        host.observe((record) => {
          if (record.nodeIds.includes(nodeId)) {
            listener();
          }
        })
      );

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
    actions: makeHandleActions(host, runner, request, driverModeOfSpec(spec)),
    action: (action, input, metadata) =>
      submitEffect(
        host,
        runActionCommand(request(), action, input, metadata),
        "GraphActionCompleted",
        ({ result }) => result
      ),
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
    updateArgs: async (nextArgs, metadata) => {
      let nextNodeId: NodeId;

      try {
        nextNodeId = host.resolveNodeIdSync({ spec, args: nextArgs });
      } catch (cause) {
        if (!isKeyError(cause)) {
          throw cause;
        }

        return {
          _tag: "Failure",
          nodeId,
          error: new UpdateNodeArgsFailed({
            nodeId,
            tag: "unknown",
            cause,
          }),
        };
      }

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

      const result = await submit(
        {
          _tag: "GraphUpdateNodeArgs",
          request: { nodeId, spec, args: nextArgs },
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
                lease: makeRuntimeNodeLiveLease(
                  host,
                  runner,
                  result.nodeId,
                  result.leaseId,
                  source,
                  scope
                ),
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
    snapshot: async () =>
      (await runner.run(host.readNodeSnapshot(nodeId))) as RuntimeNodeSnapshotLookup<TResult>,
  };
}

function makeRuntimeNodeLiveLease(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner,
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

      release = runner
        .run(
          submitEffect(
            host,
            {
              _tag: "GraphReleaseNodeLiveLease",
              request: { nodeId, leaseId },
            },
            "GraphNodeLiveLeaseReleased",
            () => undefined
          )
        )
        .then(
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

const HANDLE_ACTION_PROTOCOL_NAMES: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "constructor",
  "toString",
  "valueOf",
]);

function driverModeOfSpec(spec: unknown): DriverMode {
  const mode = (
    spec as { readonly spec?: { readonly driver?: { readonly mode?: DriverMode } } } | undefined
  )?.spec?.driver?.mode;

  return mode === "effect" ? "effect" : "async";
}

function makeHandleActions(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner,
  request: () => { readonly spec: unknown; readonly args: unknown },
  mode: DriverMode
): HandleActions<ActionContracts, DriverMode> {
  // Dispatch the same runtime action as the untyped primitive, but present it in
  // the node's authored mode: effect nodes get the Effect, async nodes get its
  // Promise projection. Protocol trap names read as undefined so the facade is
  // never mistaken for a thenable.
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string" || HANDLE_ACTION_PROTOCOL_NAMES.has(property)) {
        return undefined;
      }

      return (...input: ReadonlyArray<unknown>) => {
        const effect = submitEffect(
          host,
          runActionCommand(request(), property, input[0], undefined),
          "GraphActionCompleted",
          ({ result }) => result
        );

        return mode === "effect" ? effect : runner.run(effect);
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
  return host.submit(command).pipe(
    Effect.map((submission) => {
      if (submission._tag !== expected) {
        return unexpectedSubmission(expected, submission);
      }

      return extract(submission as Extract<RuntimeSubmission, { readonly _tag: TTag }>);
    })
  );
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
