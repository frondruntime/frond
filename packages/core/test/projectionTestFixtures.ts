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
    getSnapshotSyncFor: forbiddenSnapshot,
    getSnapshot: async () => forbiddenSnapshot(),
    getSnapshotFor: async () => forbiddenSnapshot(),
  } satisfies Runtime;

  return {
    runtime: {
      ...runtime,
      client: createRuntimeClient(runtime),
    },
    snapshotCalls: () => snapshotCalls,
  };
}
