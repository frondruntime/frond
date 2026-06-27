import { describe, expect, test } from "bun:test";
import { Context, Tracer } from "effect";
import {
  createErrorReport,
  createRuntimeEventReports,
  createRuntimeReportSink,
} from "../src/diagnostics";
import { FrondRuntimeClosed, FrondRuntimeInvariantViolation, type RuntimeId } from "../src/runtime";
import { bridgeRuntimeHost } from "../src/runtime/bridge";
import { makeRuntimeHost } from "../src/runtime/host";
import { FrondRuntimeLive } from "../src/runtime/live";
import { FrondRuntime } from "../src/runtime/types";
import { waitForRuntimeEvent, waitForRuntimeNodeRead } from "../src/testing";
import {
  type ActionContract,
  ActionProfileNode,
  createRuntime,
  Deferred,
  Driver,
  dependencies,
  Effect,
  EffectBoundaryFailed,
  Key,
  LiveDeliveryFailed,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  serviceSpec,
} from "./graphTestFixtures";

describe("runtime events", () => {
  test("runtime exposes a stable runtime id in metadata queries and snapshots", async () => {
    const runtimeId = "test-runtime" as RuntimeId;
    const runtime = createRuntime({ runtimeId });

    const status = await runtime.query({ _tag: "RuntimeStatus" });
    const events = await runtime.query({ _tag: "RuntimeEvents" });
    const snapshot = await runtime.getSnapshot();

    expect(status).toMatchObject({ _tag: "RuntimeStatus", runtimeId });
    expect(events).toMatchObject({ _tag: "RuntimeEvents", runtimeId });
    expect(snapshot.runtimeId).toBe(runtimeId);
  });

  test("separate runtimes receive separate generated ids and preserve ids after stop", async () => {
    const first = createRuntime();
    const second = createRuntime();

    const firstInitial = await first.query({ _tag: "RuntimeStatus" });
    const secondInitial = await second.query({ _tag: "RuntimeStatus" });

    expect(firstInitial._tag === "RuntimeStatus" ? firstInitial.runtimeId : undefined).not.toBe(
      secondInitial._tag === "RuntimeStatus" ? secondInitial.runtimeId : undefined
    );

    await first.submit({ _tag: "RuntimeStart" });
    await first.submit({ _tag: "RuntimeStop", reason: "identity test" });

    const firstStopped = await first.query({ _tag: "RuntimeStatus" });

    expect(firstStopped._tag === "RuntimeStatus" ? firstStopped.runtimeId : undefined).toBe(
      firstInitial._tag === "RuntimeStatus" ? firstInitial.runtimeId : undefined
    );
    expect(firstStopped._tag === "RuntimeStatus" ? firstStopped.status : undefined).toBe("stopped");
    await expect(first.submit({ _tag: "RuntimeStart" })).rejects.toBeInstanceOf(FrondRuntimeClosed);
  });

  test("runtime event records carry runtime id, monotonic sequence, classification, and failures", async () => {
    const runtimeId = "record-runtime" as RuntimeId;
    const runtime = createRuntime({ runtimeId });

    await runtime.submit({ _tag: "RuntimeStart" });

    const result = await runtime.query({ _tag: "RuntimeEvents" });

    if (result._tag !== "RuntimeEvents") {
      throw new Error("Expected runtime events query.");
    }

    expect(result.events.map((record) => record.runtimeId)).toEqual([runtimeId, runtimeId]);
    expect(result.events.map((record) => record.sequence)).toEqual([1, 2]);
    expect(result.events.map((record) => record.event._tag)).toEqual([
      "RuntimeStarted",
      "GraphSystemStarted",
    ]);
    expect(result.events.map((record) => record.classification.category)).toEqual([
      "lifecycle",
      "lifecycle",
    ]);
    expect(result.events.flatMap((record) => record.failures)).toEqual([]);
    expect(result.events.map((record) => record.work.source)).toEqual(["runtime", "runtime"]);
    expect(result.events.map((record) => record.work.reason)).toEqual(["start", "start"]);
    expect(result.events.map((record) => record.work.priority)).toEqual([
      "background",
      "background",
    ]);
    expect(result.events.map((record) => record.work.workId)).toEqual([1, 1]);
  });

  test("runtime command metadata is normalized once into event records", async () => {
    const runtime = createRuntime();

    await runtime.submit({
      _tag: "RuntimeStart",
      metadata: { source: "test", reason: "preload", priority: "idle" },
    });

    const result = await runtime.query({ _tag: "RuntimeEvents" });

    if (result._tag !== "RuntimeEvents") {
      throw new Error("Expected runtime events query.");
    }

    expect(result.events.map((record) => record.work.source)).toEqual(["test", "test"]);
    expect(result.events.map((record) => record.work.reason)).toEqual(["preload", "preload"]);
    expect(result.events.map((record) => record.work.priority)).toEqual(["idle", "idle"]);
  });

  test("unsafe node update emits a node change event", async () => {
    type UnsafeSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { value: string };
    }>;

    class UnsafeNode extends NodeBase<UnsafeSpec> {
      static readonly spec = serviceSpec<UnsafeSpec>({
        tag: "services/runtime-events-unsafe-update",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<UnsafeSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        }),
      });
    }
    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, { value: string }>(UnsafeNode, {});

    await handle.ensureReady();

    const before = await runtime.query({ _tag: "RuntimeEvents" });
    const previousSequence =
      before._tag === "RuntimeEvents" ? (before.events.at(-1)?.sequence ?? 0) : 0;
    const update = runtime.client.__unsafe.updateNode(
      handle.nodeId,
      (node) => {
        (node as { readonly result: { value: string } }).result.value = "unsafe";
      },
      { label: "test" }
    );

    expect(update).toEqual({ _tag: "Scheduled", nodeId: handle.nodeId });

    await waitForRuntimeEvent(
      runtime,
      (record) =>
        record.sequence > previousSequence &&
        record.event._tag === "GraphNodeChanged" &&
        record.event.nodeId === handle.nodeId
    );
    await waitForRuntimeEvent(
      runtime,
      (record) =>
        record.sequence > previousSequence &&
        record.event._tag === "GraphUnsafeNodeUpdated" &&
        record.event.nodeId === handle.nodeId
    );

    const after = await runtime.query({ _tag: "RuntimeEvents" });
    const updateEvents =
      after._tag === "RuntimeEvents"
        ? after.events.filter((record) => record.sequence > previousSequence)
        : [];

    expect(
      updateEvents.filter(
        (record) =>
          record.event._tag === "GraphNodeChanged" && record.event.nodeId === handle.nodeId
      )
    ).toHaveLength(1);
    expect(updateEvents.map((record) => record.event._tag)).toContain("GraphUnsafeNodeUpdated");
  });

  test("runtime command metadata fails loudly when malformed", async () => {
    const runtime = createRuntime();

    expect(() =>
      runtime.submit({
        _tag: "RuntimeStart",
        metadata: { source: "scheduler" as never },
      })
    ).toThrow(FrondRuntimeInvariantViolation);
  });

  test("runtime event retention and query limits apply explicit valid limits", async () => {
    const runtime = createRuntime({ eventBufferSize: 1 });

    await runtime.submit({ _tag: "RuntimeStart" });

    const retained = await runtime.query({ _tag: "RuntimeEvents" });
    const zero = await runtime.query({ _tag: "RuntimeEvents", limit: 0 });
    const one = await runtime.query({ _tag: "RuntimeEvents", limit: 1 });

    expect(
      retained._tag === "RuntimeEvents" ? retained.events.map((record) => record.sequence) : []
    ).toEqual([2]);
    expect(zero._tag === "RuntimeEvents" ? zero.events : []).toEqual([]);
    expect(
      one._tag === "RuntimeEvents" ? one.events.map((record) => record.event._tag) : []
    ).toEqual(["GraphSystemStarted"]);
  });

  test("runtime event limits fail loudly when malformed", async () => {
    expect(() => createRuntime({ eventBufferSize: 1.8 })).toThrow(FrondRuntimeInvariantViolation);

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    await expect(runtime.query({ _tag: "RuntimeEvents", limit: -1 })).rejects.toThrow(
      FrondRuntimeInvariantViolation
    );
    await expect(runtime.query({ _tag: "RuntimeEvents", limit: Number.NaN })).rejects.toThrow(
      FrondRuntimeInvariantViolation
    );
  });

  test("runtime command execution emits Effect spans with Frond annotations", async () => {
    const spans = makeTestTracerSpans();
    const runtimeId = "trace-runtime" as RuntimeId;
    type TraceSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class TraceNode extends NodeBase<TraceSpec> {
      static readonly spec = serviceSpec<TraceSpec>({
        tag: "services/runtime-trace",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<TraceSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
      });
    }
    const host = await Effect.runPromise(makeRuntimeHost({ runtimeId }));
    const tracer = makeTestTracer(spans);

    await Effect.runPromise(
      host
        .submit({ _tag: "GraphEnsureReadyNode", request: { spec: TraceNode, args: {} } })
        .pipe(Effect.withTracer(tracer))
    );

    expect(spans.map((span) => span.name)).toContain("frond.runtime.command.GraphEnsureReadyNode");
    expect(spans.map((span) => span.name)).toContain("frond.graph.ensureReady");
    expect(spans.map((span) => span.name)).toContain("frond.graph.acquire");
    expect(
      spans.some(
        (span) =>
          span.attributes.get("frond.runtime.id") === runtimeId &&
          span.attributes.get("frond.runtime.command") === "GraphEnsureReadyNode" &&
          span.attributes.get("frond.work.source") === "manual" &&
          span.attributes.get("frond.work.reason") === "readiness" &&
          span.attributes.get("frond.work.priority") === "visible"
      )
    ).toBe(true);
    expect(
      spans.some(
        (span) =>
          span.name === "frond.graph.acquire" &&
          span.attributes.get("frond.runtime.id") === runtimeId &&
          span.attributes.get("frond.node.tag") === "services/runtime-trace"
      )
    ).toBe(true);
  });

  test("runtime bridge maps host Effect methods through the supplied runner", async () => {
    const calls: Array<"run" | "runSync"> = [];
    const host = await Effect.runPromise(
      makeRuntimeHost({ runtimeId: "bridge-runtime" as RuntimeId })
    );
    const runtime = bridgeRuntimeHost(host, {
      run: (effect) => {
        calls.push("run");
        return Effect.runPromise(effect);
      },
      runSync: (effect) => {
        calls.push("runSync");
        return Effect.runSync(effect);
      },
    });

    const subscription = runtime.observe(() => undefined);
    await runtime.submit({ _tag: "RuntimeStart" });
    runtime.getSnapshotSync();
    await runtime.getSnapshot();
    subscription.unsubscribe();

    expect(calls).toEqual(["runSync", "run", "runSync", "run"]);
  });

  test("FrondRuntimeLive scoped finalizer stops the runtime and runs graph cleanup", async () => {
    const releases: Array<string> = [];
    const eventTags: Array<string> = [];
    type ScopedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ScopedNode extends NodeBase<ScopedSpec> {
      static readonly spec = serviceSpec<ScopedSpec>({
        tag: "services/runtime-scoped-finalizer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ScopedSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() =>
            Effect.sync(() => {
              releases.push("release");
            })
          ),
        }),
      });
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* FrondRuntime;
        yield* runtime.submit({ _tag: "RuntimeStart" });
        yield* runtime.submit({
          _tag: "GraphEnsureReadyNode",
          request: { spec: ScopedNode, args: {} },
        });
      }).pipe(
        Effect.provide(
          FrondRuntimeLive({
            runtimeId: "scoped-finalizer-runtime" as RuntimeId,
            sinks: [
              {
                name: "scoped-finalizer-sink",
                handle: (record) =>
                  Effect.sync(() => {
                    eventTags.push(record.event._tag);
                  }),
              },
            ],
          })
        )
      )
    );

    expect(releases).toEqual(["release"]);
    expect(eventTags.filter((tag) => tag === "GraphSystemStopped")).toHaveLength(1);
    expect(eventTags.filter((tag) => tag === "RuntimeStopped")).toHaveLength(1);
  });

  test("explicit RuntimeStop and scoped finalizer share the same idempotent stop path", async () => {
    const releases: Array<string> = [];
    const stoppedEvents: Array<string> = [];
    type IdempotentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class IdempotentNode extends NodeBase<IdempotentSpec> {
      static readonly spec = serviceSpec<IdempotentSpec>({
        tag: "services/runtime-idempotent-finalizer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<IdempotentSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() =>
            Effect.sync(() => {
              releases.push("release");
            })
          ),
        }),
      });
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* FrondRuntime;
        yield* runtime.submit({ _tag: "RuntimeStart" });
        yield* runtime.submit({
          _tag: "GraphEnsureReadyNode",
          request: { spec: IdempotentNode, args: {} },
        });
        yield* runtime.submit({ _tag: "RuntimeStop", reason: "explicit test stop" });
      }).pipe(
        Effect.provide(
          FrondRuntimeLive({
            runtimeId: "scoped-idempotent-runtime" as RuntimeId,
            sinks: [
              {
                name: "scoped-idempotent-sink",
                handle: (record) =>
                  Effect.sync(() => {
                    if (
                      record.event._tag === "GraphSystemStopped" ||
                      record.event._tag === "RuntimeStopped"
                    ) {
                      stoppedEvents.push(record.event._tag);
                    }
                  }),
              },
            ],
          })
        )
      )
    );

    expect(releases).toEqual(["release"]);
    expect(stoppedEvents.filter((tag) => tag === "GraphSystemStopped")).toHaveLength(1);
    expect(stoppedEvents.filter((tag) => tag === "RuntimeStopped")).toHaveLength(1);
  });

  test("runtime observers do not receive duplicate lifecycle events after stop", async () => {
    const runtime = createRuntime();
    const tags: Array<string> = [];

    runtime.observe((record) => {
      tags.push(record.event._tag);
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.submit({ _tag: "RuntimeStop", reason: "observer stop test" });
    const stoppedTags = [...tags];
    await runtime.submit({ _tag: "RuntimeStop", reason: "duplicate stop" });

    expect(tags).toEqual(stoppedTags);
  });

  test("concurrent runtime stop callers await the first cleanup owner", async () => {
    const releaseStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseGate = await Effect.runPromise(Deferred.make<void>());
    let releaseRuns = 0;
    type SlowReleaseSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SlowReleaseNode extends NodeBase<SlowReleaseSpec> {
      static readonly spec = serviceSpec<SlowReleaseSpec>({
        tag: "services/runtime-stop-slow-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowReleaseSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() =>
            Effect.gen(function* () {
              releaseRuns += 1;
              yield* Deferred.succeed(releaseStarted, undefined);
              yield* Deferred.await(releaseGate);
            })
          ),
        }),
      });
    }

    const runtime = createRuntime();

    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.client.node<Record<string, never>, string>(SlowReleaseNode, {}).ensureReady();

    const firstStop = runtime.submit({ _tag: "RuntimeStop", reason: "first stop" });
    await Effect.runPromise(Deferred.await(releaseStarted));
    const secondStop = runtime.submit({ _tag: "RuntimeStop", reason: "second stop" });
    const earlySecondResult = await Promise.race([
      secondStop.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(earlySecondResult).toBe("pending");

    await Effect.runPromise(Deferred.succeed(releaseGate, undefined));
    await expect(firstStop).resolves.toEqual({ _tag: "RuntimeStopped" });
    await expect(secondStop).resolves.toEqual({ _tag: "RuntimeStopped" });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const stoppedEvents = events.map((record) => record.event._tag);

    expect(releaseRuns).toBe(1);
    expect(stoppedEvents.filter((tag) => tag === "GraphSystemStopped")).toHaveLength(1);
    expect(stoppedEvents.filter((tag) => tag === "RuntimeStopped")).toHaveLength(1);
  });

  test("runtime emits node changes when readiness retries move error to pending", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>());
    let attempts = 0;
    type RetrySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class RetryNode extends NodeBase<RetrySpec> {
      static readonly spec = serviceSpec<RetrySpec>({
        tag: "services/runtime-readiness-retry-events",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RetrySpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              attempts += 1;

              if (attempts === 1) {
                return yield* Effect.fail(new Error("first attempt failed"));
              }

              yield* Deferred.await(gate);
              return "ready";
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, string>(RetryNode, {});

    await node.ensureReady();
    const retry = node.ensureReady();
    await waitForRuntimeNodeRead(node, (read) => read._tag === "Pending", {
      description: "readiness retry pending",
    });
    const pendingEvents = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(pendingEvents.map((record) => record.event._tag)).toEqual([
      "GraphNodeChanged",
      "GraphNodeChanged",
      "GraphNodeReadyEnsured",
      "GraphNodeChanged",
    ]);

    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await retry;
  });

  test("runtime release event carries cleanup failure for sinks", async () => {
    const cause = new Error("release rejected");
    const sinkFailures: Array<unknown> = [];
    type ReleaseFailSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseFailNode extends NodeBase<ReleaseFailSpec> {
      static readonly spec = serviceSpec<ReleaseFailSpec>({
        tag: "services/runtime-release-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleaseFailSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() => Effect.fail(cause)),
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        {
          name: "test-sink",
          handle: (record) =>
            Effect.sync(() => {
              const event = record.event;
              if (event._tag === "GraphNodeReleased") {
                sinkFailures.push(event.failure);
              }
            }),
        },
      ],
    });
    const node = runtime.client.node<Record<string, never>, string>(ReleaseFailNode, {});

    await node.ensureReady();
    await node.releaseResources("test release");
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const releaseEvent = events.find((record) => record.event._tag === "GraphNodeReleased")?.event;

    expect(releaseEvent).toMatchObject({
      _tag: "GraphNodeReleased",
      failure: { _tag: "DisposerFailed", cause },
    });
    expect(sinkFailures[0]).toMatchObject({ _tag: "DisposerFailed", cause });
  });

  test("runtime release event carries release defects as typed cleanup failures", async () => {
    const cause = new TypeError("release died");
    type ReleaseDefectSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseDefectNode extends NodeBase<ReleaseDefectSpec> {
      static readonly spec = serviceSpec<ReleaseDefectSpec>({
        tag: "services/runtime-release-defect",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleaseDefectSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() => Effect.die(cause)),
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, string>(ReleaseDefectNode, {});

    await node.ensureReady();
    await expect(node.releaseResources("test release")).resolves.toBeUndefined();
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const releaseEvent = events.find((record) => record.event._tag === "GraphNodeReleased")?.event;
    const failure = releaseEvent?._tag === "GraphNodeReleased" ? releaseEvent.failure : undefined;
    const boundary = failure?.cause;

    expect(failure).toMatchObject({ _tag: "DisposerFailed" });
    expect(boundary).toBeInstanceOf(EffectBoundaryFailed);
    expect((boundary as EffectBoundaryFailed | undefined)?.boundary).toBe("driver-release");
    expect((boundary as EffectBoundaryFailed | undefined)?.cause).toBe(cause);
  });

  test("runtime release event carries live stop failures as cleanup failures", async () => {
    const cause = new Error("unsubscribe failed");
    type LiveStopFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LiveStopFailureNode extends NodeBase<LiveStopFailureSpec> {
      static readonly spec = resourceSpec<LiveStopFailureSpec>({
        tag: "resources/runtime-live-stop-release-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LiveStopFailureSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.succeed("subscription"),
            stop: () => Effect.fail(cause),
          }),
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, string>(LiveStopFailureNode, {});

    await node.ensureReady();
    await node.acquireLiveLease("manual", { pair: "BTC/USD" });
    await expect(node.releaseResources("test release")).resolves.toBeUndefined();
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const releaseEvent = events.find((record) => record.event._tag === "GraphNodeReleased")?.event;
    const failure = releaseEvent?._tag === "GraphNodeReleased" ? releaseEvent.failure : undefined;

    expect(failure).toBeInstanceOf(LiveDeliveryFailed);
    expect(failure).toMatchObject({ _tag: "LiveDeliveryFailed", stage: "stop" });
    expect((failure as LiveDeliveryFailed | undefined)?.cause).toBe(cause);
  });

  test("runtime emits action lifecycle events and sinks observe failures", async () => {
    const sinkEvents: Array<string> = [];
    const runtime = createRuntime({
      sinks: [
        {
          name: "test-sink",
          handle: (record) =>
            Effect.sync(() => {
              sinkEvents.push(record.event._tag);
            }),
        },
      ],
    });

    const submission = await runtime.submit({
      _tag: "GraphRunAction",
      request: {
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionProfileNode, args: {} },
        },
        action: "failTimezone",
        input: { timezone: "BAD" },
      },
    });
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const eventTags = events.map((record) => record.event._tag);

    expect(submission._tag).toBe("GraphActionCompleted");
    expect(eventTags).toContain("GraphActionStarted");
    expect(eventTags).toContain("GraphNodeChanged");
    expect(eventTags.at(-1)).toBe("GraphActionFailed");
    expect(eventTags.filter((tag) => tag === "GraphActionStarted")).toHaveLength(1);
    expect(eventTags.filter((tag) => tag === "GraphActionFailed")).toHaveLength(1);
    expect(sinkEvents).toEqual(eventTags);
  });

  test("queued action started event waits for actor-owned operation start", async () => {
    const firstActionStarted = await Effect.runPromise(Deferred.make<void>());
    const firstActionGate = await Effect.runPromise(Deferred.make<void>());
    const secondActionStarted = await Effect.runPromise(Deferred.make<void>());
    let actionRuns = 0;
    type QueuedActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
      readonly actions: {
        readonly block: ActionContract<{ readonly run: number }, string>;
      };
    }>;

    class QueuedActionNode extends NodeBase<QueuedActionSpec> {
      static readonly spec = resourceSpec<QueuedActionSpec>({
        tag: "resources/runtime-action-start-boundary",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<QueuedActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          actions: {
            block: Driver.Action(() =>
              Effect.gen(function* () {
                actionRuns += 1;
                if (actionRuns === 1) {
                  yield* Deferred.succeed(firstActionStarted, undefined);
                  yield* Deferred.await(firstActionGate);
                  return "first";
                }

                yield* Deferred.succeed(secondActionStarted, undefined);
                return "second";
              })
            ),
          },
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, string>(QueuedActionNode, {});

    await node.ensureReady();
    const first = node.runAction("block", { run: 1 });
    await Effect.runPromise(Deferred.await(firstActionStarted));
    const second = node.runAction(
      "block",
      { run: 2 },
      {
        source: "test",
        reason: "action",
        priority: "visible",
      }
    );
    await Promise.resolve();

    let events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    expect(events.filter((record) => record.event._tag === "GraphActionStarted")).toHaveLength(1);

    await Effect.runPromise(Deferred.succeed(firstActionGate, undefined));
    await Effect.runPromise(Deferred.await(secondActionStarted));
    await Promise.all([first, second]);
    events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const actionStarts = events.filter((record) => record.event._tag === "GraphActionStarted");

    expect(actionStarts).toHaveLength(2);
    expect(actionStarts[1]?.work.source).toBe("test");
    expect(actionStarts[1]?.event).toMatchObject({
      _tag: "GraphActionStarted",
      input: { run: 2 },
    });
  });

  test("queued node-domain action started event waits for actor-owned operation start", async () => {
    const firstActionStarted = await Effect.runPromise(Deferred.make<void>());
    const firstActionGate = await Effect.runPromise(Deferred.make<void>());
    const secondActionStarted = await Effect.runPromise(Deferred.make<void>());
    let actionRuns = 0;
    type QueuedDomainActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
      readonly actions: {
        readonly block: ActionContract<{ readonly run: number }, string>;
      };
    }>;

    class QueuedDomainActionNode extends NodeBase<QueuedDomainActionSpec> {
      static readonly spec = resourceSpec<QueuedDomainActionSpec>({
        tag: "resources/runtime-domain-action-start-boundary",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<QueuedDomainActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          actions: {
            block: Driver.Action(() =>
              Effect.gen(function* () {
                actionRuns += 1;
                if (actionRuns === 1) {
                  yield* Deferred.succeed(firstActionStarted, undefined);
                  yield* Deferred.await(firstActionGate);
                  return "first";
                }

                yield* Deferred.succeed(secondActionStarted, undefined);
                return "second";
              })
            ),
          },
        }),
      });
    }
    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, string>(QueuedDomainActionNode, {});

    await handle.ensureReady();
    const ready = handle.read();
    if (ready._tag !== "Ready") {
      throw new Error("Expected ready node.");
    }
    const domainNode = ready.node as QueuedDomainActionNode;
    const first = domainNode.actions.block({ run: 1 });
    await Effect.runPromise(Deferred.await(firstActionStarted));
    const second = domainNode.actions.block({ run: 2 });
    await Promise.resolve();

    let events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    expect(events.filter((record) => record.event._tag === "GraphActionStarted")).toHaveLength(1);

    await Effect.runPromise(Deferred.succeed(firstActionGate, undefined));
    await Effect.runPromise(Deferred.await(secondActionStarted));
    await Promise.all([first, second]);
    events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const actionStarts = events.filter((record) => record.event._tag === "GraphActionStarted");

    expect(actionStarts).toHaveLength(2);
    expect(actionStarts[1]?.work.source).toBe("node");
    expect(actionStarts[1]?.event).toMatchObject({
      _tag: "GraphActionStarted",
      input: { run: 2 },
    });
  });

  test("refresh and args started events wait behind active actor operations", async () => {
    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    const actionGate = await Effect.runPromise(Deferred.make<void>());
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    type QueuedMaintenanceSpec = NodeSpec<{
      readonly args: { readonly filter: string };
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
      readonly actions: {
        readonly block: ActionContract<void, void>;
      };
    }>;

    class QueuedMaintenanceNode extends NodeBase<QueuedMaintenanceSpec> {
      static readonly spec = serviceSpec<QueuedMaintenanceSpec>({
        tag: "services/runtime-maintenance-start-boundary",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<QueuedMaintenanceSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.args.filter)),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* ctx.setResult("fresh");
            })
          ),
          actions: {
            block: Driver.Action(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(actionStarted, undefined);
                yield* Deferred.await(actionGate);
              })
            ),
          },
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node(QueuedMaintenanceNode, { filter: "all" });

    await node.ensureReady();
    const action = node.runAction("block");
    await Effect.runPromise(Deferred.await(actionStarted));
    const refresh = node.refresh();
    const argsUpdate = node.updateArgs({ filter: "active" });
    await Promise.resolve();

    let eventTags = (await runtime.query({ _tag: "RuntimeEvents" })).events.map(
      (record) => record.event._tag
    );
    expect(eventTags.filter((tag) => tag === "GraphRefreshStarted")).toHaveLength(0);
    expect(eventTags.filter((tag) => tag === "GraphNodeArgsUpdateStarted")).toHaveLength(0);

    await Effect.runPromise(Deferred.succeed(actionGate, undefined));
    await Effect.runPromise(Deferred.await(refreshStarted));
    await Promise.all([action, refresh, argsUpdate]);
    eventTags = (await runtime.query({ _tag: "RuntimeEvents" })).events.map(
      (record) => record.event._tag
    );

    expect(eventTags.filter((tag) => tag === "GraphRefreshStarted")).toHaveLength(1);
    expect(eventTags.filter((tag) => tag === "GraphNodeArgsUpdateStarted")).toHaveLength(1);
  });

  test("runtime emits refresh lifecycle events and sinks observe failures", async () => {
    const sinkEvents: Array<string> = [];
    type FailingRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class FailingRefreshNode extends NodeBase<FailingRefreshSpec> {
      static readonly spec = resourceSpec<FailingRefreshSpec>({
        tag: "resources/runtime-refresh-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh(() => Effect.fail({ _tag: "RefreshRejected" })),
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        {
          name: "test-sink",
          handle: (record) =>
            Effect.sync(() => {
              sinkEvents.push(record.event._tag);
            }),
        },
      ],
    });

    await runtime.submit({
      _tag: "GraphEnsureReadyNode",
      request: { spec: FailingRefreshNode, args: {} },
    });
    const submission = await runtime.submit({
      _tag: "GraphRefreshNode",
      request: {
        target: {
          _tag: "NodeRequest",
          request: { spec: FailingRefreshNode, args: {} },
        },
      },
    });
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const eventTags = events.map((record) => record.event._tag);

    expect(submission._tag).toBe("GraphRefreshCompleted");
    expect(eventTags).toContain("GraphNodeReadyEnsured");
    expect(eventTags).toContain("GraphRefreshStarted");
    expect(eventTags).toContain("GraphNodeChanged");
    expect(eventTags.at(-1)).toBe("GraphRefreshFailed");
    expect(sinkEvents).toEqual(eventTags);
  });

  test("runtime sinks can project failure-bearing events into diagnostics reports", async () => {
    const reports: Array<string> = [];
    type FailingRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class FailingRefreshNode extends NodeBase<FailingRefreshSpec> {
      static readonly spec = resourceSpec<FailingRefreshSpec>({
        tag: "resources/runtime-refresh-diagnostics",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh(() => Effect.fail({ _tag: "DiagnosticsRefreshRejected" })),
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        {
          name: "diagnostics-sink",
          handle: (record) =>
            Effect.sync(() => {
              reports.push(...createRuntimeEventReports(record).map((report) => report.message));
            }),
        },
      ],
    });

    await runtime.submit({
      _tag: "GraphEnsureReadyNode",
      request: { spec: FailingRefreshNode, args: {} },
    });
    await runtime.submit({
      _tag: "GraphRefreshNode",
      request: {
        target: {
          _tag: "NodeRequest",
          request: { spec: FailingRefreshNode, args: {} },
        },
      },
    });

    expect(reports).toEqual(["Frond operation failed: DiagnosticsRefreshRejected"]);
    expect(createErrorReport("sink primitive").message).toBe("Frond unexpected string");
  });

  test("refresh burst emits lifecycle events only for actual refresh work", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    let refreshCount = 0;
    type SlowRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class SlowRefreshNode extends NodeBase<SlowRefreshSpec> {
      static readonly spec = resourceSpec<SlowRefreshSpec>({
        tag: "resources/runtime-refresh-singleflight",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              refreshCount += 1;
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({ value: `fresh:${refreshCount}` });
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const request = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: SlowRefreshNode, args: {} },
      },
    };

    await runtime.submit({
      _tag: "GraphEnsureReadyNode",
      request: { spec: SlowRefreshNode, args: {} },
    });
    const first = runtime.submit({ _tag: "GraphRefreshNode", request });
    await Effect.runPromise(Deferred.await(refreshStarted));
    const second = runtime.submit({ _tag: "GraphRefreshNode", request });
    const third = runtime.submit({ _tag: "GraphRefreshNode", request });

    expect(refreshCount).toBe(1);
    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    const submissions = await Promise.all([first, second, third]);
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const eventTags = events.map((record) => record.event._tag);

    expect(submissions.map((submission) => submission._tag)).toEqual([
      "GraphRefreshCompleted",
      "GraphRefreshCompleted",
      "GraphRefreshCompleted",
    ]);
    expect(refreshCount).toBe(1);
    expect(eventTags.filter((tag) => tag === "GraphRefreshStarted")).toHaveLength(1);
    expect(eventTags.filter((tag) => tag === "GraphRefreshSucceeded")).toHaveLength(1);
    expect(eventTags.filter((tag) => tag === "GraphRefreshFailed")).toHaveLength(0);
  });

  test("runtime emits args reconciliation failure events and sinks observe failures", async () => {
    const sinkEvents: Array<string> = [];
    type ArgsFailureSpec = NodeSpec<{
      readonly args: { readonly filter: string };
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ArgsFailureNode extends NodeBase<ArgsFailureSpec> {
      static readonly spec = serviceSpec<ArgsFailureSpec>({
        tag: "services/runtime-args-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ArgsFailureSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.args.filter)),
          refresh: Driver.Refresh(() => Effect.fail({ _tag: "RefreshRejected" })),
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        {
          name: "test-sink",
          handle: (record) =>
            Effect.sync(() => {
              sinkEvents.push(record.event._tag);
            }),
        },
      ],
    });
    const node = runtime.client.node(ArgsFailureNode, { filter: "all" });

    await node.ensureReady();
    const result = await node.updateArgs({ filter: "active" });
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const eventTags = events.map((record) => record.event._tag);

    expect(result._tag).toBe("Failure");
    expect(eventTags).toContain("GraphNodeReadyEnsured");
    expect(eventTags).toContain("GraphNodeArgsUpdateStarted");
    expect(eventTags).toContain("GraphNodeChanged");
    expect(eventTags.at(-1)).toBe("GraphNodeArgsUpdateFailed");
    expect(sinkEvents).toEqual(eventTags);
  });

  test("runtime emits live failures to sinks without failing lease commands", async () => {
    const cause = new Error("socket refused");
    const sinkEvents: Array<string> = [];
    type LiveFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LiveFailureNode extends NodeBase<LiveFailureSpec> {
      static readonly spec = serviceSpec<LiveFailureSpec>({
        tag: "services/runtime-live-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LiveFailureSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          live: Driver.Live({
            start: () => Effect.fail(cause),
            stop: () => Effect.void,
          }),
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        {
          name: "test-sink",
          handle: (record) =>
            Effect.sync(() => {
              sinkEvents.push(record.event._tag);
            }),
        },
      ],
    });
    const node = runtime.client.node<Record<string, never>, string>(LiveFailureNode, {});

    await node.ensureReady();
    const lease = await node.acquireLiveLease("manual", { pair: "BTC/USD" });
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const liveFailure = events.find((record) => record.event._tag === "GraphNodeLiveFailed")?.event;

    expect(lease.leaseId).toBeDefined();
    expect(liveFailure).toMatchObject({
      _tag: "GraphNodeLiveFailed",
      nodeId: node.nodeId,
      failures: [{ _tag: "LiveDeliveryFailed", stage: "start", cause }],
    });
    expect(sinkEvents).toContain("GraphNodeLiveFailed");
  });

  test("runtime emits failed acquire cleanup failures to sinks", async () => {
    const acquireCause = new Error("acquire rejected");
    const cleanupCause = new Error("acquire cleanup rejected");
    const sinkEvents: Array<string> = [];
    type AcquireCleanupFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class AcquireCleanupFailureNode extends NodeBase<AcquireCleanupFailureSpec> {
      static readonly spec = serviceSpec<AcquireCleanupFailureSpec>({
        tag: "services/runtime-acquire-cleanup-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<AcquireCleanupFailureSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.gen(function* () {
              ctx.disposers.add(() => {
                throw cleanupCause;
              });

              return yield* Effect.fail(acquireCause);
            })
          ),
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        {
          name: "test-sink",
          handle: (record) =>
            Effect.sync(() => {
              sinkEvents.push(record.event._tag);
            }),
        },
      ],
    });
    const node = runtime.client.node<Record<string, never>, string>(AcquireCleanupFailureNode, {});

    await node.ensureReady();
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const cleanupFailure = events.find(
      (record) =>
        record.event._tag === "GraphNodeCleanupFailed" && record.event.reason === "acquire"
    )?.event;

    expect(node.read()).toMatchObject({
      _tag: "Error",
      error: { _tag: "AcquireFailed", cause: acquireCause },
    });
    expect(cleanupFailure).toMatchObject({
      _tag: "GraphNodeCleanupFailed",
      nodeId: node.nodeId,
      reason: "acquire",
      failures: [{ _tag: "DisposerFailed", cause: cleanupCause }],
    });
    expect(sinkEvents).toContain("GraphNodeCleanupFailed");
  });

  test("runtime stop emits cleanup failures to sinks", async () => {
    const cause = new Error("release rejected");
    const sinkEvents: Array<string> = [];
    type StopReleaseFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class StopReleaseFailureNode extends NodeBase<StopReleaseFailureSpec> {
      static readonly spec = serviceSpec<StopReleaseFailureSpec>({
        tag: "services/runtime-stop-release-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<StopReleaseFailureSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() => Effect.fail(cause)),
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        {
          name: "test-sink",
          handle: (record) =>
            Effect.sync(() => {
              sinkEvents.push(record.event._tag);
            }),
        },
      ],
    });
    const node = runtime.client.node<Record<string, never>, string>(StopReleaseFailureNode, {});

    await node.ensureReady();
    await runtime.submit({ _tag: "RuntimeStop", reason: "test stop" });
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const cleanupFailure = events.find(
      (record) => record.event._tag === "GraphNodeCleanupFailed"
    )?.event;

    expect(cleanupFailure).toMatchObject({
      _tag: "GraphNodeCleanupFailed",
      nodeId: node.nodeId,
      reason: "runtime-stop",
      failures: [{ _tag: "DisposerFailed", cause }],
    });
    expect(sinkEvents).toContain("GraphNodeCleanupFailed");
  });

  test("runtime sink failure is observed but does not fail commands", async () => {
    const runtime = createRuntime({
      sinks: [
        {
          name: "failing-sink",
          handle: () => Effect.fail(new Error("sink rejected")),
        },
      ],
    });

    await expect(runtime.submit({ _tag: "RuntimeStart" })).resolves.toEqual({
      _tag: "RuntimeStarted",
    });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(events.map((record) => record.event._tag)).toEqual([
      "RuntimeStarted",
      "RuntimeSinkFailureObserved",
      "GraphSystemStarted",
      "RuntimeSinkFailureObserved",
    ]);
    const failure = events.find(
      (record) => record.event._tag === "RuntimeSinkFailureObserved"
    )?.event;

    expect(
      failure?._tag === "RuntimeSinkFailureObserved" ? failure.cause : undefined
    ).toBeInstanceOf(EffectBoundaryFailed);
    expect(
      failure?._tag === "RuntimeSinkFailureObserved"
        ? (failure.cause as EffectBoundaryFailed).cause
        : undefined
    ).toBeInstanceOf(Error);
    expect(
      createErrorReport(failure?._tag === "RuntimeSinkFailureObserved" ? failure.cause : undefined)
        .message
    ).toBe("Frond unexpected error: Error");
  });

  test("runtime report sink handler failure is observed as a sink failure", async () => {
    type ReportSinkFailureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
      readonly actions: {
        readonly fail: ActionContract<Record<string, never>, never>;
      };
    }>;

    class ReportSinkFailureNode extends NodeBase<ReportSinkFailureSpec> {
      static readonly spec = serviceSpec<ReportSinkFailureSpec>({
        tag: "services/runtime-report-sink-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReportSinkFailureSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          actions: {
            fail: Driver.Action(() => Effect.fail(new Error("reportable action failed"))),
          },
        }),
      });
    }
    const runtime = createRuntime({
      sinks: [
        createRuntimeReportSink({
          name: "throwing-report-sink",
          handleReport: () => {
            throw new Error("report sink threw");
          },
        }),
      ],
    });
    const node = runtime.client.node<Record<string, never>, string>(ReportSinkFailureNode, {});

    await node.ensureReady();
    await node.runAction("fail", {});
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const sinkFailure = events.find(
      (record) => record.event._tag === "RuntimeSinkFailureObserved"
    )?.event;

    expect(
      sinkFailure?._tag === "RuntimeSinkFailureObserved" ? sinkFailure.cause : undefined
    ).toBeInstanceOf(EffectBoundaryFailed);
    expect(
      sinkFailure?._tag === "RuntimeSinkFailureObserved"
        ? (sinkFailure.cause as EffectBoundaryFailed).cause
        : undefined
    ).toMatchObject({
      _tag: "RuntimeReportSinkHandlerFailed",
      cause: expect.any(Error),
    });
  });

  test("runtime sink defects are observed but do not fail commands", async () => {
    const runtime = createRuntime({
      sinks: [
        {
          name: "throwing-sink",
          handle: () => {
            throw new Error("sink threw");
          },
        },
        {
          name: "defect-sink",
          handle: () => Effect.die(new Error("sink died")),
        },
      ],
    });

    await expect(runtime.submit({ _tag: "RuntimeStart" })).resolves.toEqual({
      _tag: "RuntimeStarted",
    });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(events.map((record) => record.event._tag)).toEqual([
      "RuntimeStarted",
      "RuntimeSinkFailureObserved",
      "RuntimeSinkFailureObserved",
      "GraphSystemStarted",
      "RuntimeSinkFailureObserved",
      "RuntimeSinkFailureObserved",
    ]);
    const failures = events
      .filter((record) => record.event._tag === "RuntimeSinkFailureObserved")
      .map((record) => record.event);

    expect(failures.map((event) => event.cause)).toEqual([
      expect.any(EffectBoundaryFailed),
      expect.any(EffectBoundaryFailed),
      expect.any(EffectBoundaryFailed),
      expect.any(EffectBoundaryFailed),
    ]);
  });

  test("runtime observer failure is recorded but does not fail commands", async () => {
    const runtime = createRuntime();

    runtime.observe(() => {
      throw new Error("observer rejected");
    });

    await expect(runtime.submit({ _tag: "RuntimeStart" })).resolves.toEqual({
      _tag: "RuntimeStarted",
    });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(events.map((record) => record.event._tag)).toEqual([
      "RuntimeStarted",
      "RuntimeObserverFailureObserved",
      "GraphSystemStarted",
      "RuntimeObserverFailureObserved",
    ]);
  });
});

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
