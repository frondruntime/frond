import {
  createRuntime,
  createRuntimeClient,
  type RuntimeInstance,
  type RuntimeOptions,
} from "@frondruntime/core";
import { Effect } from "effect";

export function makeInspectionSnapshotForbiddenRuntime(options: RuntimeOptions = {}): {
  readonly runtime: RuntimeInstance;
  readonly snapshotCalls: () => number;
} {
  const source = createRuntime(options);
  let snapshotCalls = 0;
  const forbiddenSnapshot = () => {
    snapshotCalls += 1;
    throw new Error("full runtime snapshot is forbidden in this test");
  };
  const runtime = {
    ...source,
    getSnapshotSync: forbiddenSnapshot,
    getSnapshotSyncFor: forbiddenSnapshot,
    getSnapshot: async () => forbiddenSnapshot(),
    getSnapshotFor: async () => forbiddenSnapshot(),
  } satisfies RuntimeInstance;

  // The client is now Effect-native: bridge the Promise facade back into the
  // Effect-native host shape createRuntimeClient expects.
  const host = {
    resolveNodeIdSync: runtime.resolveNodeIdSync,
    getStatusSync: runtime.getStatusSync,
    readNodeSnapshotSync: runtime.readNodeSnapshotSync,
    readNodeSnapshot: (nodeId: Parameters<RuntimeInstance["readNodeSnapshot"]>[0]) =>
      Effect.tryPromise({ try: () => runtime.readNodeSnapshot(nodeId), catch: (error) => error }),
    submit: (command: Parameters<RuntimeInstance["submit"]>[0]) =>
      Effect.tryPromise({ try: () => runtime.submit(command), catch: (error) => error }),
    observe: (observer: Parameters<RuntimeInstance["observe"]>[0]) =>
      Effect.sync(() => runtime.observe(observer)),
  };
  const runner = {
    run: <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect),
    runSync: <A>(effect: Effect.Effect<A, unknown>) => Effect.runSync(effect),
  };

  return {
    runtime: {
      ...runtime,
      client: createRuntimeClient(host as never, runner),
    },
    snapshotCalls: () => snapshotCalls,
  };
}
