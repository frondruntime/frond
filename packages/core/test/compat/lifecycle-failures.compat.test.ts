import { afterEach, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import { createDeferred } from "@frondruntime/core/testing";
import { Data, Effect } from "effect";

const runtimes: Frond.Runtime.Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop", reason: "compatibility teardown" });
  }
});
function createRuntime(options: Partial<Frond.Runtime.RuntimeOptions> = {}) {
  const runtime = Frond.createRuntime({ development: true, eventBufferSize: 512, ...options });
  runtimes.push(runtime);
  return runtime;
}
class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly service: string;
}> {}

type AsyncSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: string;
}>;
type EffectSpec = Frond.NodeSpec<{
  readonly mode: "effect";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: string;
}>;

for (const failureMode of ["synchronous throw", "promise rejection"] as const) {
  test(`acquire ${failureMode} resolves readiness with nested failure and rejects the ready-node read`, async () => {
    const failure = new BackendUnavailable({ service: "accounts" });
    class FailingNode extends Frond.NodeBase<AsyncSpec> {
      static readonly spec = Frond.resourceSpec.async<AsyncSpec>({
        tag: Frond.tag(`compat/lifecycle/${failureMode.replaceAll(" ", "-")}`),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => {
          if (failureMode === "synchronous throw") throw failure;
          return Promise.reject(failure);
        }),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(FailingNode, Frond.Args.none);
    // 0.5 behavior: readiness failures resolve as graph state; only ready-node reads reject.
    const outcome = await handle.ensureReady();
    expect(outcome).toMatchObject({ status: { _tag: "Wired", run: { _tag: "Error" } } });
    const expected = {
      _tag: "AcquireFailed",
      nodeId: handle.nodeId,
      tag: FailingNode.spec.tag,
      cause: {
        _tag: "DriverPromiseFailed",
        nodeId: handle.nodeId,
        operation: "acquire",
        cause: failure,
      },
    };
    expect(handle.read()).toMatchObject({ _tag: "Error", kind: "readiness", error: expected });
    expect(() => handle.readReady()).toThrow(Frond.Graph.AcquireFailed);
    await expect(handle.ensureReadyNode()).rejects.toMatchObject(expected);
  });
}

for (const failureMode of ["typed failure", "defect"] as const) {
  test(`Effect acquire ${failureMode} settles boot and preserves its public cause`, async () => {
    const failure = new BackendUnavailable({ service: "catalog" });
    // effect-mode: the compatibility contract explicitly requires Effect failure and defect coverage.
    class FailingNode extends Frond.NodeBase<EffectSpec> {
      static readonly spec = Frond.serviceSpec.effect<EffectSpec>({
        tag: Frond.tag(`compat/lifecycle/effect-${failureMode.replaceAll(" ", "-")}`),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() =>
          failureMode === "typed failure" ? Effect.fail(failure) : Effect.die(failure)
        ),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(FailingNode, Frond.Args.none);
    const semanticEvents: string[] = [];
    runtime.observe((record) => {
      if (
        record.nodeIds.includes(handle.nodeId) &&
        ["GraphNodeReadinessFailed", "GraphNodeReadyEnsured"].includes(record.event._tag)
      ) {
        if (semanticEvents.at(-1) !== record.event._tag) semanticEvents.push(record.event._tag);
      }
    });
    const pending = handle.boot();
    if (pending._tag !== "Pending") throw new Error("Expected pending boot.");
    expect(await pending.attempt).toMatchObject({
      status: { _tag: "Wired", run: { _tag: "Error" } },
    });
    const read = handle.read();
    if (read._tag !== "Error") throw new Error("Expected an acquire error.");
    expect(read.error).toBeInstanceOf(Frond.Graph.AcquireFailed);
    if (!(read.error instanceof Frond.Graph.AcquireFailed))
      throw new Error("Expected AcquireFailed.");
    if (failureMode === "typed failure") {
      expect(read.error.cause).toBe(failure);
    } else {
      expect(read.error.cause).toMatchObject({
        _tag: "EffectBoundaryFailed",
        boundary: "readiness-acquire",
        cause: failure,
      });
    }
    expect(semanticEvents).toEqual(["GraphNodeReadinessFailed", "GraphNodeReadyEnsured"]);
    // 0.5 behavior: boot preserves Error instead of passively retrying it.
    expect(handle.boot()).toMatchObject({ _tag: "Error", error: read.error });
  });
}

test("ensureReady retries an acquire failure while boot retains the failed attempt", async () => {
  const attempts: string[] = [];
  class RecoveringNode extends Frond.NodeBase<AsyncSpec> {
    static readonly spec = Frond.resourceSpec.async<AsyncSpec>({
      tag: Frond.tag("compat/lifecycle/retry"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => {
        if (attempts.length === 0) {
          attempts.push("failed");
          throw new BackendUnavailable({ service: "profile" });
        }
        attempts.push("recovered");
        return "recovered";
      }),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(RecoveringNode, Frond.Args.none);
  await handle.ensureReady();
  expect(handle.boot()._tag).toBe("Error");
  expect(attempts).toEqual(["failed"]);
  expect(await handle.ensureReadyNode()).toMatchObject({ result: "recovered" });
  expect(attempts).toEqual(["failed", "recovered"]);
});

test("a failing child surfaces its dependency name and original acquire cause at the parent", async () => {
  const failure = new BackendUnavailable({ service: "transport" });
  const parentAcquisitions: string[] = [];
  class ChildNode extends Frond.NodeBase<AsyncSpec> {
    static readonly spec = Frond.serviceSpec.async<AsyncSpec>({
      tag: Frond.tag("compat/lifecycle/failing-child"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => Promise.reject(failure)),
    });
  }
  type ParentSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Frond.Args.None;
    readonly key: Frond.Key.Singleton;
    readonly deps: { readonly transport: Frond.Dep<typeof ChildNode> };
    readonly result: string;
  }>;
  class ParentNode extends Frond.NodeBase<ParentSpec> {
    static readonly spec = Frond.facadeSpec.async<ParentSpec>({
      tag: Frond.tag("compat/lifecycle/failing-parent"),
      key: () => Frond.Key.singleton(),
      dependencies: Frond.dependencies(() => ({
        transport: Frond.dep(ChildNode, Frond.Args.none),
      })),
      acquire: Frond.Driver.Acquire(() => {
        parentAcquisitions.push("parent");
        return "unreachable";
      }),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const parent = runtime.client.node(ParentNode, Frond.Args.none);
  const child = runtime.client.node(ChildNode, Frond.Args.none);
  await parent.ensureReady();
  expect(parent.read()).toMatchObject({
    _tag: "Error",
    kind: "readiness",
    error: {
      _tag: "DependencyFailed",
      nodeId: parent.nodeId,
      tag: ParentNode.spec.tag,
      dependency: "transport",
      dependencyNodeId: child.nodeId,
      cause: {
        _tag: "AcquireFailed",
        nodeId: child.nodeId,
        cause: { _tag: "DriverPromiseFailed", cause: failure },
      },
    },
  });
  expect(parentAcquisitions).toEqual([]);
});

test("acquire timeout aborts the driver exposes deadline fields and discards late success", async () => {
  const entered = createDeferred<AbortSignal>();
  const result = createDeferred<string>();
  const completed = createDeferred<void>();
  class SlowNode extends Frond.NodeBase<AsyncSpec> {
    static readonly spec = Frond.resourceSpec.async<AsyncSpec>({
      tag: Frond.tag("compat/lifecycle/acquire-timeout"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(async (context) => {
        entered.resolve(context.signal);
        const value = await result.promise;
        context.setResult(value);
        completed.resolve();
        return value;
      }),
    });
  }
  const runtime = createRuntime({
    development: true,
    eventBufferSize: 512,
    driverTimeouts: { acquire: 15 },
  });
  const handle = runtime.client.node(SlowNode, Frond.Args.none);
  const readiness = handle.ensureReady();
  const signal = await entered.promise;
  await readiness;
  expect(signal.aborted).toBe(true);
  expect(handle.read()).toMatchObject({
    _tag: "Error",
    error: {
      _tag: "AcquireFailed",
      cause: {
        _tag: "DriverOperationTimedOut",
        nodeId: handle.nodeId,
        tag: SlowNode.spec.tag,
        operation: "acquire",
        timeout: 15,
        cancellation: { _tag: "TimedOut", detail: "15ms" },
      },
    },
  });
  result.resolve("too late");
  await completed.promise;
  expect(handle.read()._tag).toBe("Error");
  expect(runtime.client.__unsafe.readNode(handle.nodeId)._tag).toBe("Error");
  const events = await runtime.query({ _tag: "RuntimeEvents" });
  if (events._tag !== "RuntimeEvents") throw new Error("Expected retained runtime events.");
  expect(events.events.map((record) => record.event)).toContainEqual(
    expect.objectContaining({
      _tag: "GraphNodeReadinessFailed",
      nodeId: handle.nodeId,
      error: expect.objectContaining({
        _tag: "AcquireFailed",
        cause: expect.objectContaining({ _tag: "DriverOperationTimedOut" }),
      }),
    })
  );
});

test("release failure resolves cleanup reports the original cause and leaves the node reacquirable", async () => {
  const failure = new BackendUnavailable({ service: "subscription cleanup" });
  let generation = 0;
  class ResourceNode extends Frond.NodeBase<AsyncSpec> {
    static readonly spec = Frond.resourceSpec.async<AsyncSpec>({
      tag: Frond.tag("compat/lifecycle/release-failure"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => {
        generation += 1;
        return `resource:${generation}`;
      }),
      release: Frond.Driver.Release(() => {
        throw failure;
      }),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(ResourceNode, Frond.Args.none);
  await handle.ensureReady();
  // 0.5 behavior: release failure is diagnostic; releaseResources still resolves and clears readiness.
  await expect(handle.releaseResources("cleanup failed")).resolves.toBeUndefined();
  expect(handle.read()._tag).toBe("Idle");
  const query = await runtime.query({ _tag: "RuntimeEvents" });
  if (query._tag !== "RuntimeEvents") throw new Error("Expected retained runtime events.");
  expect(query.events.map((record) => record.event)).toContainEqual(
    expect.objectContaining({
      _tag: "GraphNodeReleased",
      nodeId: handle.nodeId,
      reason: "cleanup failed",
      failure: expect.objectContaining({
        _tag: "ReleaseFailed",
        nodeId: handle.nodeId,
        cause: expect.objectContaining({
          _tag: "DriverPromiseFailed",
          operation: "release",
          cause: failure,
        }),
      }),
    })
  );
  await handle.ensureReady();
  expect(handle.readReady().result).toBe("resource:2");
});
