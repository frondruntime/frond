import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeAutoObservable } from "mobx";
import { Args, Driver, Key, NodeBase, type NodeSpec, serviceSpec, tag } from "../../src";
import { isReportable } from "../../src/events";
import { EffectBoundaryFailed } from "../../src/graph";
import { type RuntimeSignalRecord, Signals } from "../../src/signals";
import { createFrondTestHarness } from "../../src/testing";

const domainChannel = Signals.channel("app.domain");
const analyticsChannel = Signals.channel("app.analytics");
const diagnosticsChannel = Signals.channel("frond.diagnostics");
const ignoredChannel = Signals.channel("app.ignored");

type DeliveredSignal = {
  readonly sequence: number;
  readonly channel: string;
  readonly name: string;
};

class AnalyticsResultStore {
  delivered: ReadonlyArray<DeliveredSignal> = [];

  constructor() {
    makeAutoObservable(this);
  }

  record(record: RuntimeSignalRecord): void {
    this.delivered = [deliveredSignal(record), ...this.delivered];
  }
}

class DiagnosticsResultStore {
  captured: ReadonlyArray<DeliveredSignal> = [];

  constructor() {
    makeAutoObservable(this);
  }

  record(record: RuntimeSignalRecord): void {
    this.captured = [deliveredSignal(record), ...this.captured];
  }
}

type AnalyticsSpec = NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: AnalyticsResultStore;
}>;

class AnalyticsNode extends NodeBase<AnalyticsSpec> {
  static readonly spec = serviceSpec<AnalyticsSpec>({
    tag: tag("e2e/signal-boundary/analytics"),
    key: () => Key.singleton(),
    driver: Driver.Effect<AnalyticsSpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.gen(function* () {
          const result = new AnalyticsResultStore();
          const subscription = yield* ctx.signals.subscribe({
            name: "e2e-analytics-node",
            channels: [analyticsChannel, domainChannel],
            handle: (record) => Effect.sync(() => result.record(record)),
          });

          ctx.disposers.add(subscription.unsubscribe);
          return result;
        })
      ),
    }),
  });
}

type DiagnosticsSpec = NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: DiagnosticsResultStore;
}>;

class DiagnosticsNode extends NodeBase<DiagnosticsSpec> {
  static readonly spec = serviceSpec<DiagnosticsSpec>({
    tag: tag("e2e/signal-boundary/diagnostics"),
    key: () => Key.singleton(),
    driver: Driver.Effect<DiagnosticsSpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.gen(function* () {
          const result = new DiagnosticsResultStore();
          const retained = yield* ctx.signals.readRetained({ channel: diagnosticsChannel });

          for (const record of retained) {
            result.record(record);
          }

          const subscription = yield* ctx.signals.subscribe({
            name: "e2e-diagnostics-node",
            channels: [diagnosticsChannel],
            handle: (record) => Effect.sync(() => result.record(record)),
          });

          ctx.disposers.add(subscription.unsubscribe);
          return result;
        })
      ),
    }),
  });
}

describe("e2e signal boundary", () => {
  test("node signal consumers compose future delivery and explicit retained reads", async () => {
    const harness = createFrondTestHarness();
    const analytics = harness.node(AnalyticsNode, Args.none);
    const diagnostics = harness.node(DiagnosticsNode, Args.none);

    await harness.start();
    await harness.runtime.publish(
      Signals.signal({ channel: domainChannel, name: "item_bought:before" }),
      { source: "test", reason: "signal", priority: "visible" }
    );
    await harness.runtime.publish(
      Signals.signal({ channel: analyticsChannel, name: "button_clicked:before" })
    );
    await harness.runtime.publish(
      Signals.signal({ channel: diagnosticsChannel, name: "error_report:retained" })
    );

    await analytics.ensureReady();
    await diagnostics.ensureReady();

    expect(harness.readReady(analytics).result?.delivered).toEqual([]);
    expect(signalNames(harness.readReady(diagnostics).result?.captured ?? [])).toEqual([
      "error_report:retained",
    ]);

    await harness.runtime.publish(
      Signals.signal({ channel: domainChannel, name: "item_bought:future" })
    );
    await harness.runtime.publish(
      Signals.signal({ channel: analyticsChannel, name: "button_clicked:future" })
    );
    await harness.runtime.publish(
      Signals.signal({ channel: diagnosticsChannel, name: "error_report:future" })
    );
    await harness.runtime.publish(Signals.signal({ channel: ignoredChannel, name: "ignored" }));

    expect(signalNames(harness.readReady(analytics).result?.delivered ?? [])).toEqual([
      "button_clicked:future",
      "item_bought:future",
    ]);
    expect(signalNames(harness.readReady(diagnostics).result?.captured ?? [])).toEqual([
      "error_report:future",
      "error_report:retained",
    ]);

    await analytics.releaseResources("e2e analytics release");
    await harness.runtime.publish(
      Signals.signal({ channel: analyticsChannel, name: "button_clicked:after-release" })
    );

    expect(signalNames(harness.readReady(diagnostics).result?.captured ?? [])).toEqual([
      "error_report:future",
      "error_report:retained",
    ]);
    expect(analytics.read()._tag).toBe("Idle");
  });

  test("failing infrastructure subscribers do not block node signal consumers", async () => {
    const harness = createFrondTestHarness({
      signalSubscribers: [
        {
          name: "e2e-failing-infrastructure-subscriber",
          channels: [analyticsChannel],
          handle: () => Effect.die(new TypeError("subscriber failed")),
        },
      ],
    });
    const analytics = harness.node(AnalyticsNode, Args.none);

    await harness.start();
    await analytics.ensureReady();
    await harness.runtime.publish(
      Signals.signal({ channel: analyticsChannel, name: "button_clicked" })
    );

    expect(signalNames(harness.readReady(analytics).result?.delivered ?? [])).toEqual([
      "button_clicked",
    ]);

    const failure = await harness.waitForEvent(
      (record) => record.event._tag === "RuntimeSignalSubscriberFailureObserved"
    );

    expect(failure?.classification.reportable).toBe(true);
    expect(failure === undefined ? false : isReportable(failure.event)).toBe(true);
    expect(
      failure?.event._tag === "RuntimeSignalSubscriberFailureObserved"
        ? failure.event.cause
        : undefined
    ).toBeInstanceOf(EffectBoundaryFailed);
  });
});

function deliveredSignal(record: RuntimeSignalRecord): DeliveredSignal {
  return {
    sequence: record.sequence,
    channel: record.signal.channel,
    name: record.signal.name,
  };
}

function signalNames(signals: ReadonlyArray<DeliveredSignal>): ReadonlyArray<string> {
  return signals.map((signal) => signal.name);
}
