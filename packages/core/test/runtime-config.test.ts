import { describe, expect, test } from "bun:test";
import { FrondRuntimeInvariantViolation, type RuntimeId } from "../src/runtime";
import { Signals } from "../src/signals";
import {
  createRuntime,
  Driver,
  dependencies,
  Effect,
  GraphConfigInvalid,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

const configSignalChannel = Signals.channel("runtime.config");

describe("runtime config normalization", () => {
  test("omitted runtime options normalize to generated id, enabled input, and retained signals", async () => {
    const runtime = createRuntime();

    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.publish(Signals.signal({ channel: configSignalChannel, name: "default" }));

    const status = await runtime.query({ _tag: "RuntimeStatus" });
    const events = await runtime.query({ _tag: "RuntimeEvents" });
    const signals = await runtime.query({ _tag: "RuntimeSignals", channel: configSignalChannel });

    expect(status).toMatchObject({ _tag: "RuntimeStatus", inputIngestionEnabled: true });
    expect(status._tag === "RuntimeStatus" ? typeof status.runtimeId : "missing").toBe("string");
    expect(events._tag === "RuntimeEvents" ? events.events.length : 0).toBeGreaterThan(0);
    expect(
      signals._tag === "RuntimeSignals" ? signals.records.map((record) => record.signal.name) : []
    ).toEqual(["default"]);
  });

  test("supplied runtime config is preserved after normalization", async () => {
    const runtimeId = "normalized-runtime" as RuntimeId;
    const runtime = createRuntime({
      runtimeId,
      inputIngestionEnabled: false,
      eventBufferSize: 1,
      signalPolicies: {
        [configSignalChannel]: { retention: "bounded", bufferSize: 1 },
      },
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.publish(Signals.signal({ channel: configSignalChannel, name: "first" }));
    await runtime.publish(Signals.signal({ channel: configSignalChannel, name: "second" }));

    const status = await runtime.query({ _tag: "RuntimeStatus" });
    const events = await runtime.query({ _tag: "RuntimeEvents" });
    const signals = await runtime.query({ _tag: "RuntimeSignals", channel: configSignalChannel });

    expect(status).toMatchObject({
      _tag: "RuntimeStatus",
      runtimeId,
      inputIngestionEnabled: false,
    });
    expect(events._tag === "RuntimeEvents" ? events.events.length : 0).toBe(1);
    expect(
      signals._tag === "RuntimeSignals" ? signals.records.map((record) => record.signal.name) : []
    ).toEqual(["second"]);
  });

  test("minimal graph options require runtime id and normalize no-op signals", async () => {
    const retainedCounts: Array<number> = [];
    type SignalReaderSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SignalReaderNode extends NodeBase<SignalReaderSpec> {
      static readonly spec = serviceSpec<SignalReaderSpec>({
        tag: "services/test-graph-signal-default",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SignalReaderSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.gen(function* () {
              const retained = yield* ctx.signals.readRetained({
                channel: configSignalChannel,
              });
              retainedCounts.push(retained.length);
              return "ready";
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem({ runtimeId: "mock-test-runtime" });

    const read = await Effect.runPromise(
      graph.ensureReadyNode({ spec: SignalReaderNode, args: {} })
    );

    expect(read.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(retainedCounts).toEqual([0]);
  });

  test("malformed config still fails loudly at construction", () => {
    expect(() =>
      createRuntime({
        syncClock: { now: undefined as never },
      })
    ).toThrow(FrondRuntimeInvariantViolation);
    expect(() => createRuntime({ eventBufferSize: -1 })).toThrow(FrondRuntimeInvariantViolation);
    expect(() =>
      createRuntime({
        signalPolicies: {
          [configSignalChannel]: { retention: "bounded", bufferSize: Number.NaN },
        },
      })
    ).toThrow(FrondRuntimeInvariantViolation);
    expect(() =>
      makeInMemoryGraphSystem({
        runtimeId: "mock-test-runtime",
        driverTimeouts: { acquire: "20 millis" as never },
      })
    ).toThrow(GraphConfigInvalid);
    expect(() =>
      makeInMemoryGraphSystem({
        runtimeId: "mock-test-runtime",
        driverTimeouts: { live: Number.NaN },
      })
    ).toThrow(GraphConfigInvalid);
  });
});
