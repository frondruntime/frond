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
    | "sinks"
    | "specOverrides"
    | "channels"
    | "signalSubscribers"
    | "signalPolicies"
    | "syncClock"
  > {
  /** Defaults to 512: tests run in development and read retained events. */
  readonly eventBufferSize?: number | undefined;
  /** Defaults to true: tests run with development checks and result freezing. */
  readonly development?: boolean | undefined;
}

const testEventBufferSize = 512;

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
    eventBufferSize: options.eventBufferSize ?? testEventBufferSize,
    development: options.development ?? true,
    sinks: [sink, ...providedSinks],
  });

  return {
    runtime,
    client: runtime.client,
    sink,
    events,
  };
}
