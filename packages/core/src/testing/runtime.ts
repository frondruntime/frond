// Public core types are imported from the package name so the emitted testing
// declaration rollup references `@frondruntime/core` instead of duplicating
// the main entry's types.
import type * as Frond from "@frondruntime/core";
import { Effect } from "effect";
import { createRuntime } from "../runtime";

export interface CapturingRuntimeSink extends Frond.Runtime.RuntimeSink {
  readonly name: "capturing-test-sink";
  readonly events: ReadonlyArray<Frond.Runtime.RuntimeEventRecord>;
}

export interface TestRuntimeOptions
  extends Pick<
    Frond.Runtime.RuntimeOptions,
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
  readonly runtime: Frond.Runtime.Runtime;
  readonly client: Frond.Runtime.RuntimeClient;
  readonly sink: CapturingRuntimeSink;
  readonly events: ReadonlyArray<Frond.Runtime.RuntimeEventRecord>;
}

export function createTestRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const events: Array<Frond.Runtime.RuntimeEventRecord> = [];
  const providedSinks = options.sinks ?? [];
  const sink = {
    name: "capturing-test-sink" as const,
    events,
    handle: (event: Frond.Runtime.RuntimeEventRecord) =>
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
