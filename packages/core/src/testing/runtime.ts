import { Effect } from "effect";
import {
  createRuntime,
  type Runtime,
  type RuntimeClient,
  type RuntimeEventRecord,
  type RuntimeOptions,
  type RuntimeSink,
} from "../runtime";

export interface CapturingRuntimeSink extends RuntimeSink {
  readonly name: "capturing-test-sink";
  readonly events: ReadonlyArray<RuntimeEventRecord>;
}

export interface TestRuntimeOptions
  extends Pick<
    RuntimeOptions,
    | "runtimeId"
    | "driverTimeouts"
    | "eventBufferSize"
    | "sinks"
    | "specOverrides"
    | "signalSubscribers"
    | "signalPolicies"
    | "syncClock"
  > {}

export interface TestRuntime {
  readonly runtime: Runtime;
  readonly client: RuntimeClient;
  readonly sink: CapturingRuntimeSink;
  readonly events: ReadonlyArray<RuntimeEventRecord>;
}

export function createTestRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const events: Array<RuntimeEventRecord> = [];
  const providedSinks = options.sinks ?? [];
  const sink = {
    name: "capturing-test-sink" as const,
    events,
    handle: (event: RuntimeEventRecord) =>
      Effect.sync(() => {
        events.push(event);
      }),
  } satisfies CapturingRuntimeSink;
  const runtime = createRuntime({
    ...options,
    sinks: [sink, ...providedSinks],
  });

  return {
    runtime,
    client: runtime.client,
    sink,
    events,
  };
}
