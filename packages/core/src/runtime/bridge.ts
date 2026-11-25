import { Effect, Exit } from "effect";
import { createRuntimeClient, type RuntimeEffectBridgeRunner } from "./client";
import { attachRuntimeCore, resolveValidatedNodeIdSlot, runtimeCore } from "./core";
import { FrondRuntimeInvariantViolation } from "./errors";
import { makeRuntimeHost } from "./host";
import { corePromise, promiseRejection } from "./promiseFacade";
import type {
  Runtime,
  RuntimeCommand,
  RuntimeControl,
  RuntimeError,
  RuntimeHostService,
  RuntimeInput,
  RuntimeObserver,
  RuntimeOptions,
  RuntimePendingOperation,
  RuntimeQuery,
  RuntimeSignal,
  RuntimeSignalSubscriber,
  RuntimeSubmission,
  RuntimeWorkMetadata,
} from "./types";

const defaultBridgeRunner: RuntimeEffectBridgeRunner = {
  run: (effect) =>
    Effect.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      throw promiseRejection(exit.cause);
    }),
  runSync: (effect) => Effect.runSync(effect),
};

/**
 * Creates the Promise/sync runtime facade used by apps and adapters.
 *
 * Host construction runs once; commands call its queue-backed core directly.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  return bridgeRuntimeHost(defaultBridgeRunner.runSync(makeRuntimeHost(options)));
}

/**
 * Exposes the host's core through the public Promise facade.
 *
 * Use this at explicit consumer boundaries, such as app setup or tests. Runtime
 * graph code should use `RuntimeHostService` directly.
 */
export function bridgeRuntimeHost(
  host: RuntimeHostService,
  runner: RuntimeEffectBridgeRunner = defaultBridgeRunner
): Runtime {
  const core = runtimeCore(host);
  if (core === undefined)
    throw new FrondRuntimeInvariantViolation({
      message: "bridgeRuntimeHost requires a host built by makeRuntimeHost.",
      cause: host,
    });
  const runtimeHost = {
    development: host.development,
    resolveNodeIdSync: host.resolveNodeIdSync,
    getStatusSync: host.getStatusSync,
    readNodeSnapshotSync: host.readNodeSnapshotSync,
    readNodeRevisionSync: host.readNodeRevisionSync,
    readNodeSnapshot: (nodeId: Parameters<RuntimeHostService["readNodeSnapshot"]>[0]) =>
      Promise.resolve(host.readNodeSnapshotSync(nodeId)),
    submit: (command: RuntimeCommand) =>
      corePromise<RuntimeSubmission, RuntimeError>(
        (resume) => core.submit(command, undefined, resume),
        undefined,
        command.metadata?.signal
      ),
    control: (control: RuntimeControl) =>
      corePromise<void, RuntimeError>((resume) => core.control(control, undefined, resume)),
    query: async (query: RuntimeQuery) => core.querySync(query),
    ingest: (input: RuntimeInput) =>
      corePromise<void, RuntimeError>((resume) => core.ingest(input, undefined, resume)),
    publish: (signal: RuntimeSignal, metadata?: RuntimeWorkMetadata | undefined) =>
      corePromise<void, RuntimeError>((resume) =>
        core.publish(signal, metadata, undefined, resume)
      ),
    recordUnsafeScheduleFailure: (command: RuntimeCommand, cause: unknown) =>
      corePromise<void, never>((resume) =>
        core.recordUnsafeScheduleFailure(command, cause, undefined, resume)
      ),
    subscribeSignals: async (subscriber: RuntimeSignalSubscriber) =>
      core.subscribeSignalsSync(subscriber),
    getSnapshotSync: () => core.getSnapshotSync(),
    getSnapshot: async () => core.getSnapshotSync(),
    observe: (observer: RuntimeObserver) => core.observeSync(observer),
  };

  // Quiescence READ, not a barrier: the narrow graph scan projects only each
  // cell's operation state — no event buffer, edges, or full per-node
  // snapshots. Kept on the Runtime facade only — node handles stay per-node
  // surfaces.
  const pendingOperations = (): ReadonlyArray<RuntimePendingOperation> =>
    host.readPendingOperationsSync();

  const runtime: Runtime = {
    ...runtimeHost,
    pendingOperations,
    isQuiescent: () => pendingOperations().length === 0,
    // Handles share the host core and retain its Effect surface for Effect callers.
    client: createRuntimeClient(host, runner),
  };
  attachRuntimeCore(runtime, core);
  // Lets an adapter that already canonicalized args skip the second pass.
  Object.defineProperty(runtime, resolveValidatedNodeIdSlot, {
    value: { owner: runtime, resolve: core.resolveValidatedNodeIdSync },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return runtime;
}
