import { describe, expect, test } from "bun:test";
import { Context, Tracer } from "effect";
import { createErrorReport } from "../src/diagnostics";
import { EffectBoundaryFailed } from "../src/graph";
import { FrondRuntimeInvariantViolation, type RuntimeId } from "../src/runtime";
import { makeRuntimeHost } from "../src/runtime/host";
import { FrondRuntimeEffect } from "../src/runtime/live";
import { type RuntimeSignalChannel, type RuntimeSignalRecord, Signals } from "../src/signals";
import {
  createRuntime,
  Driver,
  dependencies,
  Effect,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

const analyticsChannel = Signals.channel("app.analytics");
const diagnosticsChannel = Signals.channel("frond.diagnostics");
const domainEventsChannel = Signals.defineChannel({
  name: "app.domain-events",
  policy: { retention: "bounded", bufferSize: 1 },
});
const ephemeralChannel = Signals.defineChannel({
  name: "app.ephemeral",
  policy: { retention: "none" },
});

describe("runtime signals", () => {
  test("publish records runtime id, sequence, channel, name, and supports channel queries", async () => {
    const runtimeId = "signal-runtime" as RuntimeId;
    const runtime = createRuntime({ runtimeId });

    await runtime.publish(
      Signals.signal({ channel: analyticsChannel, name: "button_clicked", payload: { id: 1 } })
    );
    await runtime.publish(
      Signals.signal({ channel: diagnosticsChannel, name: "error_report", payload: { id: 2 } })
    );

    const all = await runtime.query({ _tag: "RuntimeSignals" });
    const analytics = await runtime.query({
      _tag: "RuntimeSignals",
      channel: analyticsChannel,
      limit: 1,
    });
    const empty = await runtime.query({
      _tag: "RuntimeSignals",
      channel: analyticsChannel,
      limit: 0,
    });

    expect(all).toMatchObject({ _tag: "RuntimeSignals", runtimeId });
    expect(all._tag === "RuntimeSignals" ? all.records.map(signalSummary) : []).toEqual([
      { runtimeId, sequence: 1, channel: "app.analytics", name: "button_clicked" },
      { runtimeId, sequence: 2, channel: "frond.diagnostics", name: "error_report" },
    ]);
    expect(analytics._tag === "RuntimeSignals" ? analytics.records.map(signalSummary) : []).toEqual(
      [{ runtimeId, sequence: 1, channel: "app.analytics", name: "button_clicked" }]
    );
    expect(empty._tag === "RuntimeSignals" ? empty.records : []).toEqual([]);
  });

  test("bounded retention drops oldest records and none retention stores no retained records", async () => {
    const bounded = createRuntime({
      signalPolicies: {
        [analyticsChannel]: { retention: "bounded", bufferSize: 1 },
        [diagnosticsChannel]: { retention: "none" },
      },
    });

    await bounded.publish(Signals.signal({ channel: analyticsChannel, name: "first" }));
    await bounded.publish(Signals.signal({ channel: analyticsChannel, name: "second" }));
    await bounded.publish(Signals.signal({ channel: diagnosticsChannel, name: "hidden" }));

    const result = await bounded.query({ _tag: "RuntimeSignals" });

    expect(
      result._tag === "RuntimeSignals" ? result.records.map((record) => record.signal.name) : []
    ).toEqual(["second"]);
  });

  test("bounded retention preserves global insertion order across interleaved channels", async () => {
    const runtime = createRuntime({
      signalPolicies: {
        [analyticsChannel]: { retention: "bounded", bufferSize: 2 },
        [diagnosticsChannel]: { retention: "bounded", bufferSize: 2 },
      },
    });

    const names = ["a1", "b1", "a2", "b2", "a3", "b3"];
    for (const name of names) {
      const channel = name.startsWith("a") ? analyticsChannel : diagnosticsChannel;
      await runtime.publish(Signals.signal({ channel, name }));
    }

    const namesOf = (result: Awaited<ReturnType<typeof runtime.query>>): ReadonlyArray<string> =>
      result._tag === "RuntimeSignals" ? result.records.map((record) => record.signal.name) : [];

    const all = await runtime.query({ _tag: "RuntimeSignals" });
    const analytics = await runtime.query({ _tag: "RuntimeSignals", channel: analyticsChannel });
    const diagnostics = await runtime.query({
      _tag: "RuntimeSignals",
      channel: diagnosticsChannel,
    });

    // Each channel keeps its newest two; the unfiltered view reconstructs the
    // global publish order across both channels.
    expect(namesOf(all)).toEqual(["a2", "b2", "a3", "b3"]);
    expect(namesOf(analytics)).toEqual(["a2", "a3"]);
    expect(namesOf(diagnostics)).toEqual(["b2", "b3"]);
  });

  test("channel definitions install signal retention policy and create channel-scoped signals", async () => {
    const runtime = createRuntime({
      channels: [domainEventsChannel, ephemeralChannel],
    });

    await runtime.publish(domainEventsChannel.signal("first"));
    await runtime.publish(domainEventsChannel.signal("second", { ok: true }));
    await runtime.publish(ephemeralChannel.signal("hidden"));

    const domain = await runtime.query({
      _tag: "RuntimeSignals",
      channel: domainEventsChannel.channel,
    });
    const ephemeral = await runtime.query({
      _tag: "RuntimeSignals",
      channel: ephemeralChannel.channel,
    });

    expect(domain._tag === "RuntimeSignals" ? domain.records.map(signalName) : []).toEqual([
      "second",
    ]);
    expect(ephemeral._tag === "RuntimeSignals" ? ephemeral.records : []).toEqual([]);
  });

  test("duplicate channel definitions fail loudly", () => {
    expect(() =>
      createRuntime({
        channels: [domainEventsChannel, domainEventsChannel],
      })
    ).toThrow(FrondRuntimeInvariantViolation);
  });

  test("channel definitions cannot be redefined through raw signal policies", () => {
    expect(() =>
      createRuntime({
        channels: [domainEventsChannel],
        signalPolicies: {
          [domainEventsChannel.channel]: { retention: "none" },
        },
      })
    ).toThrow(FrondRuntimeInvariantViolation);
  });

  test("zero-sized bounded retention stores no records", async () => {
    const runtime = createRuntime({
      signalPolicies: {
        [analyticsChannel]: { retention: "bounded", bufferSize: 0 },
      },
    });

    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "ignored" }));

    const result = await runtime.query({ _tag: "RuntimeSignals", channel: analyticsChannel });

    expect(result._tag === "RuntimeSignals" ? result.records : []).toEqual([]);
  });

  test("signal retention and query limits fail loudly when malformed", async () => {
    expect(() =>
      createRuntime({
        signalPolicies: {
          [analyticsChannel]: { retention: "bounded", bufferSize: 1.8 },
        },
      })
    ).toThrow(FrondRuntimeInvariantViolation);

    const runtime = createRuntime();

    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "recorded" }));
    await expect(
      runtime.query({ _tag: "RuntimeSignals", channel: analyticsChannel, limit: -1 })
    ).rejects.toThrow(FrondRuntimeInvariantViolation);
    await expect(
      runtime.query({ _tag: "RuntimeSignals", channel: analyticsChannel, limit: Number.NaN })
    ).rejects.toThrow(FrondRuntimeInvariantViolation);
  });

  test("subscriber receives only later publishes and retained records are explicit", async () => {
    const delivered: Array<string> = [];
    const runtime = createRuntime();

    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "before" }));
    const retained = await runtime.query({ _tag: "RuntimeSignals", channel: analyticsChannel });
    const subscription = await runtime.subscribeSignals({
      name: "test-subscriber",
      channels: [analyticsChannel],
      handle: (record) =>
        Effect.sync(() => {
          delivered.push(record.signal.name);
        }),
    });
    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "after" }));
    subscription.unsubscribe();
    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "ignored" }));

    expect(retained._tag === "RuntimeSignals" ? retained.records.map(signalName) : []).toEqual([
      "before",
    ]);
    expect(delivered).toEqual(["after"]);
  });

  test("driver can read retained signals explicitly", async () => {
    const delivered: Array<string> = [];
    type SignalReaderSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SignalNode extends NodeBase<SignalReaderSpec> {
      static readonly spec = serviceSpec<SignalReaderSpec>({
        tag: "services/runtime-signal-reader-node",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SignalReaderSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.gen(function* () {
              const retained = yield* ctx.signals.readRetained({ channel: analyticsChannel });
              delivered.push(...retained.map((record) => record.signal.name));
              return "ready";
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, string>(SignalNode, {});

    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "before" }));
    await node.ensureReady();

    expect(delivered).toEqual(["before"]);
  });

  test("Effect runtime construction wires graph driver signal access", async () => {
    const delivered: Array<string> = [];
    type EffectRuntimeSignalSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SignalNode extends NodeBase<EffectRuntimeSignalSpec> {
      static readonly spec = serviceSpec<EffectRuntimeSignalSpec>({
        tag: "services/effect-runtime-signal-reader",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<EffectRuntimeSignalSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.gen(function* () {
              const retained = yield* ctx.signals.readRetained({ channel: analyticsChannel });
              delivered.push(...retained.map((record) => record.signal.name));
              return "ready";
            })
          ),
        }),
      });
    }
    const runtime = await Effect.runPromise(FrondRuntimeEffect());

    await Effect.runPromise(
      runtime.publish(Signals.signal({ channel: analyticsChannel, name: "before" }))
    );
    await Effect.runPromise(
      runtime.submit({
        _tag: "GraphEnsureReadyNode",
        request: { spec: SignalNode, args: {} },
      })
    );

    expect(delivered).toEqual(["before"]);
  });

  test("subscribe is future-only and does not run retained handlers on attach", async () => {
    const host = await Effect.runPromise(makeRuntimeHost());
    const delivered: Array<string> = [];

    await Effect.runPromise(
      host.publish(Signals.signal({ channel: analyticsChannel, name: "before" }))
    );
    const subscription = await Effect.runPromise(
      host.subscribeSignals({
        name: "future-only-subscriber",
        channels: [analyticsChannel],
        handle: (record) =>
          Effect.sync(() => {
            delivered.push(record.signal.name);
          }),
      })
    );
    await Effect.runPromise(
      host.publish(Signals.signal({ channel: analyticsChannel, name: "after" }))
    );
    subscription.unsubscribe();

    expect(delivered).toEqual(["after"]);
  });

  test("subscriber failures are typed diagnostics and do not fail publish", async () => {
    const runtime = createRuntime({
      signalSubscribers: [
        {
          name: "failing-subscriber",
          channels: [analyticsChannel],
          handle: () => Effect.die(new TypeError("subscriber died")),
        },
      ],
    });

    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "button_clicked" }));
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const failure = events.find(
      (record) => record.event._tag === "RuntimeSignalSubscriberFailureObserved"
    );
    const cause =
      failure?.event._tag === "RuntimeSignalSubscriberFailureObserved"
        ? failure.event.cause
        : undefined;

    expect(cause).toBeInstanceOf(EffectBoundaryFailed);
    expect(cause).toMatchObject({ boundary: "runtime-signal-subscriber" });
    expect(createErrorReport(cause).message).toBe("Frond unexpected error: TypeError");
    expect(failure?.work).toMatchObject({
      source: "signal",
      reason: "signal",
      priority: "background",
    });
  });

  test("driver can publish and subscribe through scoped signal access", async () => {
    const delivered: Array<string> = [];
    type ScopedSignalSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SignalNode extends NodeBase<ScopedSignalSpec> {
      static readonly spec = serviceSpec<ScopedSignalSpec>({
        tag: "services/runtime-signal-node",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ScopedSignalSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.gen(function* () {
              const subscription = yield* ctx.signals.subscribe({
                name: "signal-node",
                channels: [analyticsChannel],
                handle: (record) =>
                  Effect.sync(() => {
                    delivered.push(record.signal.name);
                  }),
              });
              ctx.disposers.add(subscription.unsubscribe);
              yield* ctx.signals.publish(
                Signals.signal({ channel: analyticsChannel, name: "acquired" })
              );
              return "ready";
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, string>(SignalNode, {});

    await node.ensureReady();
    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "after" }));
    await node.releaseResources("signal test release");
    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "ignored" }));

    expect(delivered).toEqual(["acquired", "after"]);
  });

  test("async driver signal subscription uses Promise-facing handlers", async () => {
    const delivered: Array<string> = [];
    type AsyncSignalSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SignalNode extends NodeBase<AsyncSignalSpec> {
      static readonly spec = serviceSpec<AsyncSignalSpec>({
        tag: "services/async-runtime-signal-node",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Async<AsyncSignalSpec>({
          acquire: Driver.Acquire(async (ctx) => {
            const subscription = await ctx.signals.subscribe({
              name: "async-signal-node",
              channels: [analyticsChannel],
              handle: async (record) => {
                delivered.push(record.signal.name);
              },
            });
            ctx.disposers.add(subscription.unsubscribe);
            return "ready";
          }),
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, string>(SignalNode, {});

    await node.ensureReady();
    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "after" }));
    await node.releaseResources("signal test release");
    await runtime.publish(Signals.signal({ channel: analyticsChannel, name: "ignored" }));

    expect(delivered).toEqual(["after"]);
  });

  test("publish and subscriber delivery emit Effect spans with Frond signal annotations", async () => {
    const spans = makeTestTracerSpans();
    const runtimeId = "signal-trace-runtime" as RuntimeId;
    const host = await Effect.runPromise(
      makeRuntimeHost({
        runtimeId,
        signalSubscribers: [
          {
            name: "trace-subscriber",
            channels: [analyticsChannel],
            handle: () => Effect.void,
          },
        ],
      })
    );
    const tracer = makeTestTracer(spans);

    await Effect.runPromise(
      host
        .publish(Signals.signal({ channel: analyticsChannel, name: "button_clicked" }))
        .pipe(Effect.withTracer(tracer))
    );

    expect(spans.map((span) => span.name)).toContain("frond.runtime.signal.publish");
    expect(spans.map((span) => span.name)).toContain("frond.runtime.signal.deliver");
    expect(spans.map((span) => span.name)).toContain("frond.runtime.signal.subscriber");
    expect(
      spans.some(
        (span) =>
          span.attributes.get("frond.runtime.id") === runtimeId &&
          span.attributes.get("frond.signal.channel") === analyticsChannel &&
          span.attributes.get("frond.signal.name") === "button_clicked" &&
          span.attributes.get("frond.signal.sequence") === 1 &&
          span.attributes.get("frond.work.source") === "signal" &&
          span.attributes.get("frond.work.reason") === "signal"
      )
    ).toBe(true);
    expect(
      spans.some((span) => span.attributes.get("frond.signal.subscriber") === "trace-subscriber")
    ).toBe(true);
  });
});

function signalSummary(record: RuntimeSignalRecord): {
  readonly runtimeId: RuntimeId;
  readonly sequence: number;
  readonly channel: RuntimeSignalChannel;
  readonly name: string;
} {
  return {
    runtimeId: record.runtimeId,
    sequence: record.sequence,
    channel: record.signal.channel,
    name: record.signal.name,
  };
}

function signalName(record: RuntimeSignalRecord): string {
  return record.signal.name;
}

type TestSpan = {
  readonly name: string;
  readonly attributes: Map<string, unknown>;
};

function makeTestTracerSpans(): Array<TestSpan> {
  return [];
}

function makeTestTracer(spans: Array<TestSpan>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const attributes = new Map<string, unknown>();
      const testSpan = { name: options.name, attributes };
      spans.push(testSpan);

      return {
        _tag: "Span",
        name: options.name,
        spanId: `span-${spans.length}`,
        traceId: "trace",
        parent: options.parent,
        annotations: Context.empty(),
        get status() {
          return { _tag: "Started", startTime: options.startTime } as const;
        },
        attributes,
        links: [],
        sampled: options.sampled,
        kind: options.kind,
        end: () => {},
        attribute: (key, value) => {
          attributes.set(key, value);
        },
        event: () => {},
        addLinks: () => {},
      };
    },
  });
}
