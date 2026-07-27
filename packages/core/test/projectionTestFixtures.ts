import { Effect } from "effect";
import {
  createRuntime,
  createRuntimeClient,
  type Runtime,
  type RuntimeOptions,
} from "../src/runtime";

export function makeInspectionSnapshotForbiddenRuntime(options: RuntimeOptions = {}): {
  readonly runtime: Runtime;
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
    getSnapshot: async () => forbiddenSnapshot(),
  } satisfies Runtime;

  // The client is now Effect-native: bridge the Promise facade back into the
  // Effect-native host shape createRuntimeClient expects.
  const host = {
    resolveNodeIdSync: runtime.resolveNodeIdSync,
    getStatusSync: runtime.getStatusSync,
    readNodeSnapshotSync: runtime.readNodeSnapshotSync,
    readNodeRevisionSync: runtime.readNodeRevisionSync,
    readNodeSnapshot: (nodeId: Parameters<Runtime["readNodeSnapshot"]>[0]) =>
      Effect.tryPromise({ try: () => runtime.readNodeSnapshot(nodeId), catch: (error) => error }),
    submit: (command: Parameters<Runtime["submit"]>[0]) =>
      Effect.tryPromise({ try: () => runtime.submit(command), catch: (error) => error }),
    observe: (observer: Parameters<Runtime["observe"]>[0]) =>
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
