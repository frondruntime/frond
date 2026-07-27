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
import {
  FrondNodeNotReady,
  type FrondNodeReadiness,
  FrondRuntimeInvariantViolation,
} from "./errors";
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
  | "readNodeRevisionSync"
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
      createRuntimeNodeHandle<NodeSpecArgs<TSpec>, NodeSpecResult<TSpec>, RuntimeHandleNode<TSpec>>(
        host,
        runner,
        spec,
        args
      ) as RuntimeNodeHandle<
        NodeSpecArgs<TSpec>,
        NodeSpecResult<TSpec>,
        NodeSpecActions<TSpec>,
        NodeSpecMode<TSpec>,
        RuntimeHandleNode<TSpec>
      >,
    __unsafe: createUnsafeRuntimeClient(host, runner),
  };
}

function createRuntimeNodeHandle<TArgs, TResult, TNode extends object = object>(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner,
  spec: unknown,
  args: TArgs
): RuntimeNodeHandle<TArgs, TResult, Record<string, never>, "async", TNode> {
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
        return bootingRuntimeNodeRead<TResult, TNode>(
          nodeId,
          settleBootAttempt(nodeId, ensureReady(metadata)),
          read.tag
        );
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
    readReady,
    ensureReadyNode: async (metadata) => {
      // One awaited readiness attempt, then the same sync projection readReady
      // performs — so both surfaces throw identically for error/not-ready.
      await ensureReady(metadata);
      return readReady();
    },
    // Mirror the type-level `NodeSpecMode` via the shared mode recovery, so a
    // bare effect-mode descriptor dispatches Effect-native actions instead of
    // silently degrading to the Promise projection.
    actions: makeHandleActions(host, runner, request, recoverDriverMode(spec)),
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
      (await runner.run(host.readNodeSnapshot(nodeId))) as RuntimeNodeSnapshotLookup<
        TResult,
        TNode
      >,
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

function makeHandleActions(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner,
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

const signalAborted = Symbol("frond.runtime/action-signal-aborted");

/**
 * Ties `metadata.signal` to Effect interruption for a caller-cancellable action
 * submission.
 *
 * An already-aborted signal settles as interruption without submitting at all.
 * Otherwise the submission races an abort waiter: when the signal fires,
 * `raceFirst` interrupts the losing submission fiber and awaits that
 * interruption before resuming, so the abort takes exactly the
 * caller-fiber-interruption path the graph already pins — the cell actor claims
 * the reply and interrupts the worker (`cellActor.ts` awaiter propagation), a
 * queued worker never invokes the driver, an active single-owner operation
 * aborts its `ctx.signal` (`driverOperationRunner.ts` onInterrupt), and a joined
 * operation keeps running for its other awaiters. The overall effect then
 * settles as interruption, which `unwrapEffect` rejects with the interrupted
 * `Cause`.
 */
function interruptOnSignal<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    if (signal.aborted) {
      return Effect.interrupt;
    }

    return Effect.raceFirst(effect, awaitAbort(signal)).pipe(
      Effect.flatMap((value) =>
        value === signalAborted ? Effect.interrupt : Effect.succeed(value as A)
      )
    );
  });
}

function awaitAbort(signal: AbortSignal): Effect.Effect<typeof signalAborted> {
  return Effect.callback<typeof signalAborted>((resume) => {
    const onAbort = () => resume(Effect.succeed(signalAborted));
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
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
