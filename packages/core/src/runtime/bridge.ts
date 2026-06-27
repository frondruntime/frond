import { Effect } from "effect";
import { createRuntimeClient } from "./client";
import { makeRuntimeHost } from "./host";
import type {
  Runtime,
  RuntimeCommand,
  RuntimeControl,
  RuntimeHostService,
  RuntimeInput,
  RuntimeObserver,
  RuntimeOptions,
  RuntimeQuery,
  RuntimeSignal,
  RuntimeSignalSubscriber,
  RuntimeSnapshotPurpose,
  RuntimeWorkMetadata,
} from "./types";

export interface RuntimeEffectBridgeRunner {
  readonly run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  readonly runSync: <A>(effect: Effect.Effect<A, unknown>) => A;
}

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
    readNodeSnapshot: (nodeId: Parameters<RuntimeHostService["readNodeSnapshot"]>[0]) =>
      runner.run(host.readNodeSnapshot(nodeId)),
    submit: (command: RuntimeCommand) => runner.run(host.submit(command)),
    control: (control: RuntimeControl) => runner.run(host.control(control)),
    query: (query: RuntimeQuery) => runner.run(host.query(query)),
    ingest: (input: RuntimeInput) => runner.run(host.ingest(input)),
    publish: (signal: RuntimeSignal, metadata?: RuntimeWorkMetadata | undefined) =>
      runner.run(host.publish(signal, metadata)),
    subscribeSignals: (subscriber: RuntimeSignalSubscriber) =>
      runner.run(host.subscribeSignals(subscriber)),
    getSnapshotSync: () => runner.runSync(host.getSnapshot()),
    getSnapshotSyncFor: (purpose: RuntimeSnapshotPurpose) =>
      runner.runSync(host.getSnapshotFor(purpose)),
    getSnapshot: () => runner.run(host.getSnapshot()),
    getSnapshotFor: (purpose: RuntimeSnapshotPurpose) => runner.run(host.getSnapshotFor(purpose)),
    observe: (observer: RuntimeObserver) => runner.runSync(host.observe(observer)),
  };

  return {
    ...runtimeHost,
    client: createRuntimeClient(runtimeHost),
  };
}
