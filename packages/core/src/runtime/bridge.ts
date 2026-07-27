import { Effect } from "effect";
import { createRuntimeClient, type RuntimeEffectBridgeRunner } from "./client";
import { makeRuntimeHost } from "./host";
import type {
  Runtime,
  RuntimeCommand,
  RuntimeControl,
  RuntimeHostService,
  RuntimeInput,
  RuntimeObserver,
  RuntimeOptions,
  RuntimePendingOperation,
  RuntimeQuery,
  RuntimeSignal,
  RuntimeSignalSubscriber,
  RuntimeWorkMetadata,
} from "./types";

const defaultBridgeRunner: RuntimeEffectBridgeRunner = {
  run: (effect) => Effect.runPromise(effect),
  runSync: (effect) => Effect.runSync(effect),
};

/**
 * Creates the Promise/sync runtime facade used by apps and adapters.
 *
 * Boundary: runtime internals stay Effect-native. This function runs host
 * construction once and bridges host commands for consumer code.
 */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return bridgeRuntimeHost(defaultBridgeRunner.runSync(makeRuntimeHost(options)));
}

/**
 * Bridges an Effect-native runtime host to the public runtime facade.
 *
 * Use this at explicit consumer boundaries, such as app setup or tests. Runtime
 * graph code should use `RuntimeHostService` directly.
 */
export function bridgeRuntimeHost(
  host: RuntimeHostService,
  runner: RuntimeEffectBridgeRunner = defaultBridgeRunner
): Runtime {
  const runtimeHost = {
    resolveNodeIdSync: host.resolveNodeIdSync,
    getStatusSync: host.getStatusSync,
    readNodeSnapshotSync: host.readNodeSnapshotSync,
    readNodeRevisionSync: host.readNodeRevisionSync,
    readNodeSnapshot: (nodeId: Parameters<RuntimeHostService["readNodeSnapshot"]>[0]) =>
      runner.run(host.readNodeSnapshot(nodeId)),
    submit: (command: RuntimeCommand) => runner.run(host.submit(command)),
    control: (control: RuntimeControl) => runner.run(host.control(control)),
    query: (query: RuntimeQuery) => runner.run(host.query(query)),
    ingest: (input: RuntimeInput) => runner.run(host.ingest(input)),
    publish: (signal: RuntimeSignal, metadata?: RuntimeWorkMetadata | undefined) =>
      runner.run(host.publish(signal, metadata)),
    recordUnsafeScheduleFailure: (command: RuntimeCommand, cause: unknown) =>
      runner.run(host.recordUnsafeScheduleFailure(command, cause)),
    recordMobXProjectionFailure: (
      nodeId: Parameters<RuntimeHostService["recordMobXProjectionFailure"]>[0],
      cause: unknown
    ) => runner.run(host.recordMobXProjectionFailure(nodeId, cause)),
    subscribeSignals: (subscriber: RuntimeSignalSubscriber) =>
      runner.run(host.subscribeSignals(subscriber)),
    getSnapshotSync: () => runner.runSync(host.getSnapshot()),
    getSnapshot: () => runner.run(host.getSnapshot()),
    observe: (observer: RuntimeObserver) => runner.runSync(host.observe(observer)),
  };

  // Quiescence READ, not a barrier: the narrow graph scan projects only each
  // cell's operation state — no event buffer, edges, or full per-node
  // snapshots. Kept on the Runtime facade only — node handles stay per-node
  // surfaces.
  const pendingOperations = (): ReadonlyArray<RuntimePendingOperation> =>
    host.readPendingOperationsSync();

  return {
    ...runtimeHost,
    pendingOperations,
    isQuiescent: () => pendingOperations().length === 0,
    // The client is built over the Effect-native host directly (not the Promise
    // facade above) and owns its own Effect→Promise bridging via the runner.
    client: createRuntimeClient(host, runner),
  };
}
