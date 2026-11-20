import { afterEach, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import { createDeferred } from "@frondruntime/core/testing";
import { Data } from "effect";

const runtimes: Frond.Runtime.Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop", reason: "compatibility teardown" });
  }
});
function createRuntime() {
  const runtime = Frond.createRuntime();
  runtimes.push(runtime);
  return runtime;
}
type StringSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: string;
}>;
class RefreshUnavailable extends Data.TaggedError("RefreshUnavailable")<{
  readonly service: string;
}> {}

function distinct<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

test("concurrent refresh callers join one result while the previous result remains readable", async () => {
  const started = createDeferred<void>();
  const refreshed = createDeferred<void>();
  let generation = 0;
  class ProfileNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/refresh-join"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => "initial"),
      refresh: Frond.Driver.Refresh(async (context) => {
        generation += 1;
        started.resolve();
        await refreshed.promise;
        context.setResult(`fresh:${generation}`);
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(ProfileNode, Frond.Args.none);
  await handle.ensureReady();
  const states: string[] = [];
  const unsubscribe = handle.subscribe(() => {
    const read = handle.read();
    if (read._tag === "Ready") states.push(read.result);
  });
  states.push("initial");
  const first = handle.refresh();
  await started.promise;
  expect(handle.read()).toMatchObject({ _tag: "Ready", result: "initial", busy: true });
  const second = handle.refresh();
  const third = handle.refresh();
  refreshed.resolve();
  for (const result of await Promise.all([first, second, third])) {
    expect(result).toMatchObject({ _tag: "Success", nodeId: handle.nodeId, value: "fresh:1" });
  }
  unsubscribe();
  expect(handle.read()).toMatchObject({ _tag: "Ready", result: "fresh:1", busy: false });
  expect(distinct(states)).toEqual(["initial", "fresh:1"]);
});

test("refresh submitted during acquisition waits for readiness before refreshing the acquired result", async () => {
  const acquireStarted = createDeferred<void>();
  const acquired = createDeferred<string>();
  const order: string[] = [];
  class ProfileNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/refresh-acquiring"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(async () => {
        acquireStarted.resolve();
        const value = await acquired.promise;
        order.push("acquired");
        return value;
      }),
      refresh: Frond.Driver.Refresh((context) => {
        order.push("refreshed");
        context.setResult("fresh");
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(ProfileNode, Frond.Args.none);
  const readiness = handle.ensureReady();
  await acquireStarted.promise;
  const refresh = handle.refresh();
  acquired.resolve("initial");
  await readiness;
  expect(await refresh).toMatchObject({ _tag: "Success", value: "fresh" });
  expect(order).toEqual(["acquired", "refreshed"]);
  expect(handle.readReady().result).toBe("fresh");
});

test("refresh failure rolls back staged data preserves the old result and emits ordered failure events", async () => {
  const failure = new RefreshUnavailable({ service: "profile" });
  class ProfileNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/refresh-failure"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => "stable"),
      refresh: Frond.Driver.Refresh((context) => {
        context.setResult("uncommitted");
        throw failure;
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(ProfileNode, Frond.Args.none);
  await handle.ensureReady();
  const result = await handle.refresh();
  expect(result).toMatchObject({
    _tag: "Failure",
    nodeId: handle.nodeId,
    error: {
      _tag: "RefreshFailed",
      nodeId: handle.nodeId,
      cause: { _tag: "DriverPromiseFailed", operation: "refresh", cause: failure },
    },
  });
  expect(handle.read()).toMatchObject({
    _tag: "Ready",
    result: "stable",
    busy: false,
    operationFailure: { kind: "refresh", error: { _tag: "RefreshFailed" } },
  });
  const query = await runtime.query({ _tag: "RuntimeEvents" });
  if (query._tag !== "RuntimeEvents") throw new Error("Expected retained runtime events.");
  const events = query.events;
  expect(
    distinct(
      events
        .filter((record) => record.nodeIds.includes(handle.nodeId))
        .map((record) => record.event._tag)
        .filter(
          (eventTag) => eventTag === "GraphRefreshStarted" || eventTag === "GraphRefreshFailed"
        )
    )
  ).toEqual(["GraphRefreshStarted", "GraphRefreshFailed"]);
});

test("manual demand starts live resources and only the final lease disposal stops them", async () => {
  const liveStates: string[] = [];
  class SubscriptionNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/demand"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => "ready"),
      live: Frond.Driver.Live({
        start: (_context, demand) => {
          liveStates.push("live");
          return demand.scopes;
        },
        stop: (context) => {
          liveStates.push(context.reason._tag);
        },
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(SubscriptionNode, Frond.Args.none);
  expect(await handle.acquireLiveLease("manual", { topic: "prices" })).toMatchObject({
    _tag: "NodeMissing",
  });
  await handle.ensureReady();
  expect(liveStates).toEqual([]);
  const first = await handle.acquireLiveLease("manual", { topic: "prices" });
  const second = await handle.acquireLiveLease("manual", { topic: "prices" });
  if (first._tag !== "Held" || second._tag !== "Held") throw new Error("Expected held leases.");
  expect(first.liveDemand).toEqual({
    isLive: true,
    sources: ["manual"],
    scopes: [{ topic: "prices" }],
  });
  await first.lease.dispose();
  expect(distinct(liveStates)).toEqual(["live"]);
  expect(await handle.snapshot()).toMatchObject({
    _tag: "Found",
    snapshot: { liveDemand: { isLive: true } },
  });
  await second.lease.dispose();
  await second.lease.dispose();
  expect(distinct(liveStates)).toEqual(["live", "DemandInactive"]);
  expect(await handle.snapshot()).toMatchObject({
    _tag: "Found",
    snapshot: { liveDemand: { isLive: false, sources: [], scopes: [] } },
  });
  expect(handle.readReady().result).toBe("ready");
});

for (const termination of ["evict", "stop"] as const) {
  test(`${termination} aborts pending acquire settles its callers and prevents a late result from becoming ready`, async () => {
    const started = createDeferred<AbortSignal>();
    const acquired = createDeferred<string>();
    const completed = createDeferred<void>();
    const cleanup: string[] = [];
    class PendingNode extends Frond.NodeBase<StringSpec> {
      static readonly spec = Frond.resourceSpec.async<StringSpec>({
        tag: Frond.tag(`compat/lifecycle/pending-acquire-${termination}`),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(async (context) => {
          context.disposers.add(() => {
            cleanup.push("acquire disposed");
          });
          started.resolve(context.signal);
          const value = await acquired.promise;
          context.setResult(value);
          completed.resolve();
          return value;
        }),
      });
    }
    const runtime = createRuntime();
    const handle = runtime.client.node(PendingNode, Frond.Args.none);
    const boot = handle.boot();
    if (boot._tag !== "Pending") throw new Error("Expected pending acquisition.");
    const signal = await started.promise;
    const readiness = handle.ensureReady();
    if (termination === "evict") await handle.evict("selfAndDependents", "cancel acquire");
    else await runtime.submit({ _tag: "RuntimeStop", reason: "cancel acquire" });
    const outcomes = await Promise.all([boot.attempt, readiness]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        _tag: "Error",
        nodeId: handle.nodeId,
        status: { _tag: "Wired", run: { _tag: "Error" } },
        error: {
          _tag: "NodeEvicted",
          nodeId: handle.nodeId,
          tag: PendingNode.spec.tag,
          cancellation: { _tag: termination === "evict" ? "Evicted" : "RuntimeStopped" },
        },
      });
    }
    expect(signal.aborted).toBe(true);
    expect(cleanup).toEqual(["acquire disposed"]);
    acquired.resolve("late");
    await completed.promise;
    const expectedState = termination === "evict" ? "Unwired" : "Error";
    expect(handle.read()._tag).toBe(expectedState);
    if (termination === "stop") {
      expect(handle.boot()).toMatchObject({
        _tag: "Error",
        kind: "runtime",
        error: { _tag: "FrondRuntimeUnavailable" },
      });
      await expect(handle.ensureReady()).rejects.toMatchObject({
        _tag: "FrondRuntimeClosed",
        operation: "GraphEnsureReadyNode",
      });
      await expect(handle.refresh()).rejects.toMatchObject({
        _tag: "FrondRuntimeClosed",
        operation: "GraphRefreshNode",
      });
      await expect(runtime.submit({ _tag: "RuntimeStart" })).rejects.toMatchObject({
        _tag: "FrondRuntimeClosed",
        operation: "RuntimeStart",
      });
      expect(runtime.client.__unsafe.readNode(handle.nodeId)._tag).toBe("Unavailable");
    }
  });
}

for (const termination of ["evict", "stop"] as const) {
  test(`${termination} cancels a pending action without committing its late staged result`, async () => {
    const started = createDeferred<AbortSignal>();
    const actionResult = createDeferred<string>();
    const completed = createDeferred<void>();
    const cleanup: string[] = [];
    type ActionSpec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly args: Frond.Args.None;
      readonly key: Frond.Key.Singleton;
      readonly result: string;
      readonly actions: { readonly save: Frond.ActionContract<void, string> };
    }>;
    class ActionNode extends Frond.NodeBase<ActionSpec> {
      static readonly spec = Frond.resourceSpec.async<ActionSpec>({
        tag: Frond.tag(`compat/lifecycle/pending-action-${termination}`),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => "stable"),
        release: Frond.Driver.Release(({ node }) => {
          cleanup.push(node.result);
        }),
        actions: {
          save: Frond.Driver.Action(async (context) => {
            started.resolve(context.signal);
            const value = await actionResult.promise;
            context.setResult(value);
            completed.resolve();
            return value;
          }),
        },
      });
    }
    const runtime = createRuntime();
    const handle = runtime.client.node(ActionNode, Frond.Args.none);
    await handle.ensureReady();
    const action = handle.actions.save();
    const signal = await started.promise;
    if (termination === "evict") await handle.evict("selfAndDependents", "cancel save");
    else await runtime.submit({ _tag: "RuntimeStop", reason: "cancel save" });
    expect(await action).toMatchObject({
      _tag: "Failure",
      nodeId: handle.nodeId,
      error: {
        _tag: "ActionFailed",
        action: "save",
        cause: {
          _tag: "NodeEvicted",
          nodeId: handle.nodeId,
          cancellation: { _tag: termination === "evict" ? "Evicted" : "RuntimeStopped" },
        },
      },
    });
    expect(signal.aborted).toBe(true);
    expect(cleanup).toEqual(["stable"]);
    actionResult.resolve("late");
    await completed.promise;
    expect(handle.read()._tag).toBe(termination === "evict" ? "Unwired" : "Error");
  });
}

test("releaseResources clears readiness releases live resources and runs disposers in reverse order", async () => {
  const cleanup: string[] = [];
  let generation = 0;
  class ResourceNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/release"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire((context) => {
        generation += 1;
        const acquiredGeneration = generation;
        for (const name of ["first", "second", "third"]) {
          context.disposers.add(() => {
            cleanup.push(`${acquiredGeneration}:${name}`);
          });
        }
        return `resource:${generation}`;
      }),
      release: Frond.Driver.Release(({ node }) => {
        cleanup.push(`release:${node.result}`);
      }),
      live: Frond.Driver.Live({
        start: () => "subscription",
        stop: (context, resource) => {
          cleanup.push(`${context.reason._tag}:${resource}`);
        },
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(ResourceNode, Frond.Args.none);
  await handle.ensureReady();
  const lease = await handle.acquireLiveLease("manual", {});
  expect(lease._tag).toBe("Held");
  await handle.releaseResources("replace resource");
  expect(handle.read()._tag).toBe("Idle");
  expect(cleanup).toEqual([
    "NodeReleased:subscription",
    "release:resource:1",
    "1:third",
    "1:second",
    "1:first",
  ]);
  await handle.ensureReady();
  expect(handle.readReady().result).toBe("resource:2");
  await handle.releaseResources("replace resource again");
  expect(cleanup.slice(-4)).toEqual(["release:resource:2", "2:third", "2:second", "2:first"]);
});

test("releaseResources waits for pending acquire before releasing the acquired resource", async () => {
  const started = createDeferred<AbortSignal>();
  const acquired = createDeferred<string>();
  const order: string[] = [];
  class PendingNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/release-pending-acquire"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(async (context) => {
        started.resolve(context.signal);
        const result = await acquired.promise;
        order.push("acquired");
        return result;
      }),
      release: Frond.Driver.Release(({ node }) => {
        order.push(`released:${node.result}`);
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(PendingNode, Frond.Args.none);
  const readiness = handle.ensureReady();
  const signal = await started.promise;
  // 0.5 behavior: release is queued behind acquire; it does not cancel a pending hook.
  const release = handle.releaseResources("release pending acquire");
  expect(signal.aborted).toBe(false);
  acquired.resolve("resource");
  expect(await readiness).toMatchObject({ status: { _tag: "Wired", run: { _tag: "Ready" } } });
  await release;
  expect(order).toEqual(["acquired", "released:resource"]);
  expect(handle.read()._tag).toBe("Idle");
});

test("releaseResources waits for a pending action and releases its committed result", async () => {
  const started = createDeferred<AbortSignal>();
  const saved = createDeferred<void>();
  const released: string[] = [];
  type SaveSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Frond.Args.None;
    readonly key: Frond.Key.Singleton;
    readonly result: string;
    readonly actions: { readonly save: Frond.ActionContract<void, string> };
  }>;
  class SaveNode extends Frond.NodeBase<SaveSpec> {
    static readonly spec = Frond.resourceSpec.async<SaveSpec>({
      tag: Frond.tag("compat/lifecycle/release-pending-action"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => "initial"),
      release: Frond.Driver.Release(({ node }) => {
        released.push(node.result);
      }),
      actions: {
        save: Frond.Driver.Action(async (context) => {
          started.resolve(context.signal);
          await saved.promise;
          context.setResult("saved");
          return "receipt";
        }),
      },
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(SaveNode, Frond.Args.none);
  await handle.ensureReady();
  const action = handle.actions.save();
  const signal = await started.promise;
  // 0.5 behavior: release waits for action completion instead of interrupting it.
  const release = handle.releaseResources("release pending save");
  expect(signal.aborted).toBe(false);
  saved.resolve();
  expect(await action).toMatchObject({ _tag: "Success", value: "receipt" });
  await release;
  expect(released).toEqual(["saved"]);
  expect(handle.read()._tag).toBe("Idle");
});

test("runtime stop settles joined pending refresh callers and discards late refresh writes", async () => {
  const started = createDeferred<AbortSignal>();
  const refreshed = createDeferred<void>();
  const completed = createDeferred<void>();
  class RefreshNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/stop-pending-refresh"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => "stable"),
      refresh: Frond.Driver.Refresh(async (context) => {
        started.resolve(context.signal);
        await refreshed.promise;
        context.setResult("late");
        completed.resolve();
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(RefreshNode, Frond.Args.none);
  await handle.ensureReady();
  const first = handle.refresh();
  const signal = await started.promise;
  const second = handle.refresh();
  await runtime.submit({ _tag: "RuntimeStop", reason: "stop refresh" });
  for (const result of await Promise.all([first, second])) {
    expect(result).toMatchObject({
      _tag: "Failure",
      nodeId: handle.nodeId,
      error: {
        _tag: "RefreshFailed",
        cause: { _tag: "NodeEvicted", cancellation: { _tag: "RuntimeStopped" } },
      },
    });
  }
  expect(signal.aborted).toBe(true);
  refreshed.resolve();
  await completed.promise;
  expect(handle.read()).toMatchObject({ _tag: "Error", kind: "runtime" });
  expect(runtime.readNodeSnapshotSync(handle.nodeId)).toMatchObject({
    _tag: "Found",
    snapshot: { _tag: "Idle" },
  });
});
