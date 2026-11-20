import { afterEach, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import * as FrondTest from "@frondruntime/core/testing";
import { Cause, Context, Effect, Exit, Fiber, Layer, Tracer } from "effect";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

function createHarness(options: FrondTest.FrondTestHarnessOptions = {}) {
  const harness = FrondTest.createFrondTestHarness(options);
  harnesses.push(harness);
  return harness;
}

type AccountSpec = Frond.NodeSpec<{
  readonly mode: "effect";
  readonly args: { readonly currency: string };
  readonly key: Frond.Key.Singleton;
  readonly result: { balance: number; currency: string };
  readonly actions: {
    readonly deposit: Frond.ActionContract<number, number>;
    readonly reject: Frond.ActionContract<void, void>;
  };
}>;

// effect-mode: regression coverage of the 0.5 Effect channel — confirmed by worker task.
class AccountNode extends Frond.NodeBase<AccountSpec> {
  static readonly spec = Frond.serviceSpec.effect<AccountSpec>({
    tag: Frond.tag("compat/effect/account"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire((context) =>
      Effect.succeed({ balance: 10, currency: context.args.currency })
    ),
    refresh: Frond.Driver.Refresh((context) =>
      context.setResult({ balance: 20, currency: context.args.currency })
    ),
    actions: {
      deposit: Frond.Driver.Action((context, amount) =>
        Effect.gen(function* () {
          yield* context.patchResult((result) => {
            result.balance += amount;
          });
          return amount;
        })
      ),
      reject: Frond.Driver.Action((context) =>
        Effect.gen(function* () {
          yield* context.patchResult((result) => {
            result.balance = -1;
          });
          return yield* Effect.fail({ _tag: "DepositRejected", reason: "account locked" });
        })
      ),
    },
  });
}

test("Effect handles expose committed actions and awaited lifecycle results", async () => {
  const harness = createHarness();
  await harness.start();
  const handle = harness.node(AccountNode, { currency: "USD" });
  await handle.ensureReady();
  expect(handle.read()).toMatchObject({ _tag: "Ready", result: { balance: 10, currency: "USD" } });
  const action = handle.actions.deposit(5);
  expect(Effect.isEffect(action)).toBe(true);
  expect(await Effect.runPromise(action)).toMatchObject({ _tag: "Success", value: 5 });
  expect(handle.readReady().result.balance).toBe(15);
  expect(await handle.refresh()).toMatchObject({ _tag: "Success" });
  expect(handle.readReady().result.balance).toBe(20);
  expect(await handle.updateArgs({ currency: "EUR" })).toMatchObject({ _tag: "Success" });
  expect(handle.readReady().result).toEqual({ balance: 20, currency: "EUR" });
  await handle.releaseResources("compat release");
  expect(handle.read()._tag).toBe("Idle");
  await handle.ensureReady();
  expect(handle.readReady().result).toEqual({ balance: 10, currency: "EUR" });
  await handle.evict();
  expect(handle.read()._tag).toBe("Unwired");
});

test("Effect handles return operation failures as values while node actions fail the Effect", async () => {
  const harness = createHarness();
  const node = await harness.startNode(AccountNode, { currency: "USD" });
  const handle = harness.node(AccountNode, { currency: "USD" });
  // 0.5 behavior: the handle succeeds with Failure; the ready node lifts it into the error channel.
  const outcome = await Effect.runPromise(handle.actions.reject());
  expect(outcome).toMatchObject({
    _tag: "Failure",
    error: { _tag: "ActionFailed", action: "reject" },
  });
  const failure = await Effect.runPromise(Effect.flip(node.actions.reject()));
  expect(failure).toMatchObject({
    _tag: "ActionFailed",
    cause: { _tag: "DepositRejected", reason: "account locked" },
  });
  expect(node.result).toEqual({ balance: 10, currency: "USD" });
  expect(handle.read()).toMatchObject({ _tag: "Ready", operationFailure: { kind: "action" } });
});

test("Effect actions fail with the runtime error after stop", async () => {
  const harness = createHarness();
  const handle = harness.node(AccountNode, { currency: "USD" });
  await handle.ensureReady();
  await harness.stop();
  expect(await Effect.runPromise(Effect.flip(handle.actions.deposit(1)))).toMatchObject({
    _tag: "FrondRuntimeClosed",
    operation: "GraphRunAction",
  });
});

for (const failedOperation of ["acquire", "refresh"] as const) {
  test(`Effect ${failedOperation} failures preserve the domain cause and staged result rollback`, async () => {
    type FailureSpec = Frond.NodeSpec<{
      readonly mode: "effect";
      readonly key: Frond.Key.Singleton;
      readonly result: { value: string };
    }>;
    // effect-mode: expected driver failure channels — confirmed by worker task.
    class FailureNode extends Frond.NodeBase<FailureSpec> {
      static readonly spec = Frond.serviceSpec.effect<FailureSpec>({
        tag: Frond.tag(`compat/effect/failure/${failedOperation}`),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() =>
          failedOperation === "acquire"
            ? Effect.fail({ _tag: "BackendUnavailable", service: "accounts" })
            : Effect.succeed({ value: "original" })
        ),
        refresh: Frond.Driver.Refresh((context) =>
          Effect.gen(function* () {
            yield* context.setResult({ value: "discarded" });
            return yield* Effect.fail({ _tag: "BackendUnavailable", service: "accounts" });
          })
        ),
      });
    }
    const harness = createHarness();
    const handle = harness.node(FailureNode, {});
    await handle.ensureReady();
    if (failedOperation === "acquire") {
      // Expected acquisition failures preserve the application failure as their cause.
      expect(harness.readError(handle)).toMatchObject({
        error: {
          _tag: "AcquireFailed",
          cause: { _tag: "BackendUnavailable", service: "accounts" },
        },
      });
    } else {
      expect(await handle.refresh()).toMatchObject({
        _tag: "Failure",
        error: {
          _tag: "RefreshFailed",
          cause: { _tag: "BackendUnavailable", service: "accounts" },
        },
      });
      expect(handle.read()).toMatchObject({
        _tag: "Ready",
        result: { value: "original" },
        operationFailure: { kind: "refresh", error: { _tag: "RefreshFailed" } },
      });
    }
  });
}

function createWaitingNode(admission: "queue" | "join" = "queue") {
  const started = FrondTest.createDeferred<void>();
  const gate = FrondTest.createDeferred<void>();
  const finalized = FrondTest.createDeferred<void>();
  const released: string[] = [];
  const lifecycle: string[] = [];
  let operationSignal: AbortSignal | undefined;
  type WaitingSpec = Frond.NodeSpec<{
    readonly mode: "effect";
    readonly key: Frond.Key.Singleton;
    readonly result: { value: string };
    readonly actions: { readonly wait: Frond.ActionContract<void, string> };
  }>;
  // effect-mode: explicit interruption and finalizer coverage — confirmed by worker task.
  class WaitingNode extends Frond.NodeBase<WaitingSpec> {
    static readonly spec = Frond.resourceSpec.effect<WaitingSpec>({
      tag: Frond.tag(`compat/effect/waiting/${admission}`),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => Effect.succeed({ value: "original" })),
      release: Frond.Driver.Release(() =>
        Effect.sync(() => {
          lifecycle.push("released");
          released.push("released");
        })
      ),
      actions: {
        wait: Frond.Driver.Action(
          (context) =>
            Effect.gen(function* () {
              operationSignal = context.signal;
              yield* context.patchResult((result) => {
                result.value = "committed";
              });
              started.resolve();
              yield* Effect.promise(() => gate.promise);
              return "finished";
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  lifecycle.push("finalized");
                  finalized.resolve();
                })
              )
            ),
          { admission }
        ),
      },
    });
  }
  return {
    WaitingNode,
    started,
    gate,
    finalized,
    released,
    lifecycle,
    signal: () => operationSignal,
  };
}

test("Interrupting a sole action caller finalizes the body and rolls back staged state", async () => {
  const fixture = createWaitingNode();
  const harness = createHarness();
  const handle = harness.node(fixture.WaitingNode, {});
  await handle.ensureReady();
  const caller = Effect.runFork(handle.actions.wait());
  await fixture.started.promise;
  await Effect.runPromise(Fiber.interrupt(caller));
  await fixture.finalized.promise;
  const exit = await Effect.runPromise(Fiber.await(caller));
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(fixture.signal()?.aborted).toBe(true);
  expect(handle.readReady().result.value).toBe("original");
  expect(fixture.released).toEqual([]);
});

test("An Effect action deadline interrupts the body and preserves the previous result", async () => {
  const fixture = createWaitingNode();
  const harness = createHarness({ driverTimeouts: { action: 5 } });
  const handle = harness.node(fixture.WaitingNode, {});
  await handle.ensureReady();
  const outcome = await Effect.runPromise(handle.actions.wait());
  await fixture.finalized.promise;
  expect(outcome).toMatchObject({
    _tag: "Failure",
    error: {
      _tag: "ActionFailed",
      cause: {
        _tag: "DriverOperationTimedOut",
        operation: "action:wait",
        timeout: 5,
      },
    },
  });
  expect(fixture.signal()?.aborted).toBe(true);
  expect(handle.readReady().result.value).toBe("original");
});

test("Interrupting a joined caller leaves shared work running until it commits", async () => {
  const fixture = createWaitingNode("join");
  const harness = createHarness();
  const handle = harness.node(fixture.WaitingNode, {});
  await handle.ensureReady();
  const caller = Effect.runFork(handle.actions.wait());
  await fixture.started.promise;
  await Effect.runPromise(Fiber.interrupt(caller));
  // 0.5 behavior: join work survives even when its only caller leaves.
  expect(fixture.signal()?.aborted).toBe(false);
  expect(handle.readReady().result.value).toBe("original");
  const committed = harness.waitForEvent((record) => record.event._tag === "GraphActionSucceeded");
  fixture.gate.resolve();
  await fixture.finalized.promise;
  await committed;
  expect(handle.readReady().result.value).toBe("committed");
});

for (const ending of ["eviction", "runtime stop"] as const) {
  test(`${ending} interrupts an Effect body and runs finalizers before releasing the result`, async () => {
    const fixture = createWaitingNode();
    const harness = createHarness();
    const handle = harness.node(fixture.WaitingNode, {});
    await handle.ensureReady();
    const caller = Effect.runFork(handle.actions.wait());
    await fixture.started.promise;
    if (ending === "eviction") await handle.evict();
    else await harness.stop();
    await fixture.finalized.promise;
    await Effect.runPromise(Fiber.await(caller));
    expect(fixture.signal()?.aborted).toBe(true);
    expect(fixture.released).toEqual(["released"]);
    expect(fixture.lifecycle).toEqual(["finalized", "released"]);
    // 0.5 behavior: a stopped handle projects Error, rather than a separate stopped phase.
    expect(handle.read()._tag).toBe(ending === "eviction" ? "Unwired" : "Error");
    if (ending === "runtime stop") {
      expect(handle.read()).toMatchObject({
        kind: "runtime",
        error: { _tag: "FrondRuntimeUnavailable" },
      });
    }
  });
}

test("Effect drivers read provided services and complete sleeps and local timeouts", async () => {
  class ExchangeRate extends Context.Service<ExchangeRate, { readonly rate: number }>()(
    "compat/ExchangeRate"
  ) {}
  const exchangeRate = Layer.succeed(ExchangeRate)({ rate: 7 });
  type TimedSpec = Frond.NodeSpec<{
    readonly mode: "effect";
    readonly key: Frond.Key.Singleton;
    readonly result: number;
    readonly actions: { readonly timeout: Frond.ActionContract<void, string> };
  }>;
  // effect-mode: Effect service and timing coverage — confirmed by worker task.
  class TimedNode extends Frond.NodeBase<TimedSpec> {
    static readonly spec = Frond.serviceSpec.effect<TimedSpec>({
      tag: Frond.tag("compat/effect/timed"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() =>
        Effect.gen(function* () {
          const service = yield* ExchangeRate;
          yield* Effect.sleep("1 millis");
          return service.rate;
        }).pipe(Effect.provide(exchangeRate))
      ),
      actions: {
        timeout: Frond.Driver.Action(() =>
          Effect.never.pipe(
            Effect.timeout("1 millis"),
            Effect.catchTag("TimeoutError", () => Effect.succeed("timed out"))
          )
        ),
      },
    });
  }
  const harness = createHarness();
  const node = await harness.startNode(TimedNode, {});
  expect(node.result).toBe(7);
  expect(await Effect.runPromise(node.actions.timeout())).toBe("timed out");
  expect(node.result).toBe(7);
});

test("Effect action submissions deliver named spans to the caller tracer", async () => {
  const names: string[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      names.push(options.name);
      const attributes = new Map<string, unknown>();
      return {
        _tag: "Span",
        name: options.name,
        spanId: String(names.length),
        traceId: "compat",
        parent: options.parent,
        annotations: Context.empty(),
        status: { _tag: "Started", startTime: options.startTime },
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
  const harness = createHarness();
  const handle = harness.node(AccountNode, { currency: "USD" });
  await handle.ensureReady();
  await Effect.runPromise(handle.actions.deposit(1).pipe(Effect.withTracer(tracer)));
  expect(names).toContain("frond.runtime.command.GraphRunAction");
  expect(names).toContain("frond.graph.action");
});

test("Typed signals preserve delivery order and bounded retention through stop", async () => {
  const channel = Frond.Signals.defineChannel<{ changed: { value: number } }>({
    name: "compat/signals/typed",
    policy: { retention: "bounded", bufferSize: 2 },
  });
  const delivered: number[] = [];
  const harness = createHarness({
    channels: [channel],
    signalSubscribers: [
      channel.subscriber({
        name: "typed consumer",
        handle: (record) =>
          Effect.sync(() => {
            delivered.push(record.signal.payload.value);
          }),
      }),
    ],
  });
  await harness.start();
  for (const value of [1, 2, 3])
    await harness.runtime.publish(channel.signal("changed", { value }));
  expect(delivered).toEqual([1, 2, 3]);
  const retained = await harness.runtime.query({
    _tag: "RuntimeSignals",
    channel: channel.channel,
  });
  expect(retained).toMatchObject({
    _tag: "RuntimeSignals",
    records: [
      { signal: { name: "changed", payload: { value: 2 } } },
      { signal: { name: "changed", payload: { value: 3 } } },
    ],
  });
  if (retained._tag !== "RuntimeSignals") throw new Error("Expected signal query");
  expect(retained.records[0]?.sequence).toBeLessThan(retained.records[1]?.sequence ?? 0);
  await harness.stop();
  await expect(
    harness.runtime.publish(channel.signal("changed", { value: 4 }))
  ).rejects.toMatchObject({ _tag: "FrondRuntimeClosed" });
  expect(delivered).toEqual([1, 2, 3]);
  await expect(
    harness.runtime.subscribeSignals(
      channel.subscriber({
        name: "after stop",
        handle: () => Effect.void,
      })
    )
  ).rejects.toMatchObject({ _tag: "FrondRuntimeClosed", operation: "RuntimeSignalSubscribe" });
  expect(await harness.runtime.query({ _tag: "RuntimeSignals", channel: channel.channel })).toEqual(
    retained
  );
});

test("Driver signal subscriptions filter channels and dispose when the node releases", async () => {
  const channel = Frond.Signals.channel("compat/signals/driver");
  const delivered: string[] = [];
  type SignalSpec = Frond.NodeSpec<{
    readonly mode: "effect";
    readonly key: Frond.Key.Singleton;
    readonly result: string;
  }>;
  // effect-mode: driver signal Effect access — confirmed by worker task.
  class SignalNode extends Frond.NodeBase<SignalSpec> {
    static readonly spec = Frond.serviceSpec.effect<SignalSpec>({
      tag: Frond.tag("compat/effect/signals"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire((context) =>
        Effect.gen(function* () {
          const subscription = yield* context.signals.subscribe({
            name: "driver consumer",
            channels: [channel],
            handle: (record) =>
              Effect.sync(() => {
                delivered.push(record.signal.name);
              }),
          });
          context.disposers.add(subscription.unsubscribe);
          yield* context.signals.publish(Frond.Signals.signal({ channel, name: "acquired" }));
          return "ready";
        })
      ),
    });
  }
  const harness = createHarness({ signalPolicies: { [channel]: { retention: "none" } } });
  const handle = harness.node(SignalNode, {});
  await handle.ensureReady();
  await harness.runtime.publish(Frond.Signals.signal({ channel: "other", name: "ignored" }));
  await harness.runtime.publish(Frond.Signals.signal({ channel, name: "after" }));
  await handle.releaseResources();
  await harness.runtime.publish(Frond.Signals.signal({ channel, name: "released" }));
  expect(delivered).toEqual(["acquired", "after"]);
  expect(await harness.runtime.query({ _tag: "RuntimeSignals", channel })).toMatchObject({
    records: [],
  });
});

test("A signal subscriber failure is diagnostic and does not reject publication or block later subscribers", async () => {
  const delivered: string[] = [];
  const harness = createHarness();
  const failing = await harness.runtime.subscribeSignals({
    name: "failing subscriber",
    handle: () => Effect.fail({ _tag: "ConsumerRejected", reason: "offline" }),
  });
  const receiving = await harness.runtime.subscribeSignals({
    name: "receiving subscriber",
    handle: (record) =>
      Effect.sync(() => {
        delivered.push(record.signal.name);
      }),
  });
  await harness.runtime.publish(
    Frond.Signals.signal({ channel: "compat/signals/failure", name: "first" })
  );
  expect(delivered).toEqual(["first"]);
  expect(
    await harness.waitForEvent(
      (record) => record.event._tag === "RuntimeSignalSubscriberFailureObserved"
    )
  ).toMatchObject({
    event: { _tag: "RuntimeSignalSubscriberFailureObserved", subscriber: "failing subscriber" },
  });
  failing.unsubscribe();
  receiving.unsubscribe();
  await harness.runtime.publish(
    Frond.Signals.signal({ channel: "compat/signals/failure", name: "after unsubscribe" })
  );
  expect(delivered).toEqual(["first"]);
});

test("Live work starts on demand stops on eviction and restarts after reacquisition", async () => {
  const lifecycle: string[] = [];
  type LiveSpec = Frond.NodeSpec<{
    readonly mode: "effect";
    readonly key: Frond.Key.Singleton;
    readonly result: string;
  }>;
  // effect-mode: live resource lifecycle coverage — confirmed by worker task.
  class LiveNode extends Frond.NodeBase<LiveSpec> {
    static readonly spec = Frond.resourceSpec.effect<LiveSpec>({
      tag: Frond.tag("compat/effect/live"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => Effect.succeed("ready")),
      live: Frond.Driver.Live({
        start: () =>
          Effect.sync(() => {
            lifecycle.push("start");
            return "subscription";
          }),
        stop: (context, resource) =>
          Effect.sync(() => {
            lifecycle.push(`${resource}:${context.reason._tag}`);
          }),
      }),
    });
  }
  const harness = createHarness();
  const handle = harness.node(LiveNode, {});
  await handle.ensureReady();
  expect(lifecycle).toEqual([]);
  const first = await handle.acquireLiveLease("manual", { topic: "prices" });
  expect(first._tag).toBe("Held");
  expect(lifecycle).toEqual(["start"]);
  await handle.evict();
  expect(lifecycle).toEqual(["start", "subscription:NodeEvicted"]);
  await handle.ensureReady();
  const second = await handle.acquireLiveLease("manual", { topic: "prices" });
  if (second._tag !== "Held") throw new Error("Expected live lease");
  expect(lifecycle).toEqual(["start", "subscription:NodeEvicted", "start"]);
  await second.lease.dispose();
  expect(lifecycle).toEqual([
    "start",
    "subscription:NodeEvicted",
    "start",
    "subscription:DemandInactive",
  ]);
});
