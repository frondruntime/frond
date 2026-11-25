import {
  createRuntime,
  createRuntimeClient,
  type RuntimeInstance,
  type RuntimeOptions,
} from "@frondruntime/core";
import { effectBridgeRunner, effectHostFromRuntime } from "@frondruntime/core/testing";

export function makeInspectionSnapshotForbiddenRuntime(options: Partial<RuntimeOptions> = {}): {
  readonly runtime: RuntimeInstance;
  readonly snapshotCalls: () => number;
} {
  const source = createRuntime({ development: true, eventBufferSize: 512, ...options });
  let snapshotCalls = 0;
  const forbiddenSnapshot = () => {
    snapshotCalls += 1;
    throw new Error("full runtime snapshot is forbidden in this test");
  };
  const runtime = {
    ...source,
    getSnapshotSync: forbiddenSnapshot,
    getSnapshot: async () => forbiddenSnapshot(),
  } satisfies RuntimeInstance;

  return {
    runtime: {
      ...runtime,
      client: createRuntimeClient(effectHostFromRuntime(runtime), effectBridgeRunner),
    },
    snapshotCalls: () => snapshotCalls,
  };
}
