import { describe, expect, test } from "bun:test";
import { GraphSystemLive } from "../src/graph/system";
import { GraphSystem } from "../src/graph/types";
import {
  AcquireFailed,
  type ActionContract,
  Context,
  Deferred,
  type Dep,
  DependencyFailures,
  DisposerFailed,
  Driver,
  DriverOperationTimedOut,
  DriverPromiseFailed,
  dep,
  dependencies,
  Effect,
  EffectBoundaryFailed,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  NodeEvicted,
  type NodeSpec,
  ProfileNode,
  resourceSpec,
  resultCommit,
  serviceSpec,
  TransportNode,
} from "./graphTestFixtures";

describe("graph execution", () => {
  test("GraphSystemLive finalizer stops graph actors and releases resources", async () => {
    const releases: Array<string> = [];
    type ScopedGraphSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ScopedGraphNode extends NodeBase<ScopedGraphSpec> {
      static readonly spec = serviceSpec<ScopedGraphSpec>({
        tag: "services/graph-live-finalizer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ScopedGraphSpec>({
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
        const graph = yield* GraphSystem;
        yield* graph.start();
        yield* graph.ensureReadyNode({ spec: ScopedGraphNode, args: {} });
      }).pipe(
        Effect.provide(
          GraphSystemLive({
            runtimeId: "graph-live-finalizer-runtime",
          })
        )
      )
    );

    expect(releases).toEqual(["release"]);
  });

  test("ensureReady runs dependencies first and stores ready results", async () => {
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: ProfileNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const profile = snapshot.nodes.find((node) => node.tag === "resources/profile");
    const transport = snapshot.nodes.find((node) => node.tag === "services/transport");

    expect(handle.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(profile?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(profile?.result).toBe("profile:transport");
    expect(transport?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(transport?.result).toBe("transport");
  });

  test("undefined acquire result is still an explicit ready result", async () => {
    type UndefinedResultSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: undefined;
    }>;

    class UndefinedResultNode extends NodeBase<UndefinedResultSpec> {
      static readonly spec = resourceSpec<UndefinedResultSpec>({
        tag: "resources/undefined-result",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<UndefinedResultSpec>({
          acquire: Driver.Acquire(() => Effect.succeed(undefined)),
        }),
      });

      get loaded() {
        return this.result === undefined;
      }
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: UndefinedResultNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/undefined-result");
    const readyNode = node?.node as UndefinedResultNode | undefined;

    expect(handle.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(readyNode?.result).toBeUndefined();
    expect(readyNode?.loaded).toBe(true);
  });

  test("ready author node exposes runtime identity args deps result and domain getters", async () => {
    type ReadyFieldsSpec = NodeSpec<{
      readonly args: { readonly suffix: string };
      readonly key: Key.Structure<{ readonly suffix: string }>;
      readonly deps: {
        readonly transport: Dep<typeof TransportNode>;
      };
      readonly result: { readonly label: string };
    }>;

    class ReadyFieldsNode extends NodeBase<ReadyFieldsSpec> {
      static readonly spec = resourceSpec<ReadyFieldsSpec>({
        tag: "resources/ready-fields",
        key: (args) => Key.structure({ suffix: args.suffix }),
        dependencies: dependencies(() => ({
          transport: dep(TransportNode, {}),
        })),
        driver: Driver.Effect<ReadyFieldsSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed({
              label: `${ctx.deps.transport.result}:${ctx.args.suffix}`,
            })
          ),
        }),
      });

      get label(): string {
        return `${this.result.label}:${this.args.suffix}`;
      }
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReadyFieldsNode, args: { suffix: "ready" } })
    );
    const lookup = graph.readNodeSnapshotSync(handle.nodeId, {
      _tag: "FullInspection",
      includeDetails: true,
    });

    expect(lookup._tag).toBe("Found");

    if (lookup._tag !== "Found" || lookup.snapshot._tag !== "Ready") {
      throw new Error("Expected ready node snapshot.");
    }

    const node = lookup.snapshot.node as ReadyFieldsNode;

    expect(node).toBeInstanceOf(ReadyFieldsNode);
    expect(node.nodeId).toBe(handle.nodeId);
    expect(node.tag).toBe("resources/ready-fields");
    expect(node.args).toEqual({ suffix: "ready" });
    expect(node.deps.transport).toBeInstanceOf(TransportNode);
    expect(node.deps.transport.result).toBe("transport");
    expect(node.result).toEqual({ label: "transport:ready" });
    expect(node.label).toBe("transport:ready:ready");
  });

  test("acquire can use args deps signal and disposers without reading ctx.node", async () => {
    let disposed = 0;
    let capturedSignalAborted: boolean | undefined;
    type ContextOnlySpec = NodeSpec<{
      readonly args: { readonly id: string };
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: {
        readonly transport: Dep<typeof TransportNode>;
      };
      readonly result: { readonly value: string };
    }>;

    class ContextOnlyNode extends NodeBase<ContextOnlySpec> {
      static readonly spec = resourceSpec<ContextOnlySpec>({
        tag: "resources/context-only-acquire",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({
          transport: dep(TransportNode, {}),
        })),
        driver: Driver.Effect<ContextOnlySpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              capturedSignalAborted = ctx.signal.aborted;
              ctx.disposers.add(() => {
                disposed += 1;
              });

              return {
                value: `${ctx.args.id}:${ctx.deps.transport.result}:${String(ctx.signal.aborted)}`,
              };
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ContextOnlyNode, args: { id: "alpha" } })
    );
    const lookup = graph.readNodeSnapshotSync(handle.nodeId, {
      _tag: "FullInspection",
      includeDetails: true,
    });

    expect(lookup).toMatchObject({
      _tag: "Found",
      snapshot: {
        _tag: "Ready",
        result: { value: "alpha:transport:false" },
      },
    });
    expect(capturedSignalAborted).toBe(false);

    await Effect.runPromise(graph.releaseNode(handle.nodeId));

    expect(disposed).toBe(1);
  });

  test("acquire timeout records readiness failure", async () => {
    type AcquireTimeoutSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class AcquireTimeoutNode extends NodeBase<AcquireTimeoutSpec> {
      static readonly spec = serviceSpec<AcquireTimeoutSpec>({
        tag: "services/acquire-timeout",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<AcquireTimeoutSpec>({
          acquire: Driver.Acquire(() => Effect.never),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { acquire: 20 },
    });

    const handle = await Effect.runPromise(
      graph
        .ensureReadyNode({ spec: AcquireTimeoutNode, args: {} })
        .pipe(Effect.timeout("200 millis"))
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/acquire-timeout");
    const error = handle.status._tag === "Wired" ? handle.status.run : undefined;

    expect(error).toMatchObject({ _tag: "Error" });
    expect(node?.failure).toBeInstanceOf(AcquireFailed);
    expect((node?.failure as AcquireFailed | undefined)?.cause).toBeInstanceOf(
      DriverOperationTimedOut
    );
    expect((node?.failure as AcquireFailed | undefined)?.cause).toMatchObject({
      cancellation: { _tag: "TimedOut", detail: "20ms" },
    });
  });

  test("release timeout is recorded as cleanup failure and completes", async () => {
    type ReleaseTimeoutSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseTimeoutNode extends NodeBase<ReleaseTimeoutSpec> {
      static readonly spec = serviceSpec<ReleaseTimeoutSpec>({
        tag: "services/release-timeout",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleaseTimeoutSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() => Effect.never),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 20 },
    });

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReleaseTimeoutNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId).pipe(Effect.timeout("200 millis")));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/release-timeout");

    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.failure).toBeInstanceOf(DisposerFailed);
    expect((node?.failure as DisposerFailed | undefined)?.cause).toBeInstanceOf(
      DriverOperationTimedOut
    );
    expect((node?.failure as DisposerFailed | undefined)?.cause).toMatchObject({
      cancellation: { _tag: "TimedOut", detail: "20ms" },
    });
  });

  test("dependency node objects are passed to dependent drivers", async () => {
    let capturedDependency: object | undefined;
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ProfileNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const transport = snapshot.nodes.find((node) => node.tag === "services/transport");

    type CaptureSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly transport: Dep<typeof TransportNode>;
      };
      readonly result: string;
    }>;

    class CaptureNode extends NodeBase<CaptureSpec> {
      static readonly spec = resourceSpec<CaptureSpec>({
        tag: "resources/capture-transport-node",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          transport: dep(TransportNode, {}),
        })),
        driver: Driver.Effect<CaptureSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              capturedDependency = ctx.deps.transport;
              return ctx.deps.transport.result;
            })
          ),
        }),
      });
    }

    await Effect.runPromise(graph.ensureReadyNode({ spec: CaptureNode, args: {} }));

    expect(capturedDependency).toBe(transport?.node);
  });

  test("direct dependency readiness fans out before awaiting sibling completion", async () => {
    const leftStarted = await Effect.runPromise(Deferred.make<void>());
    const leftGate = await Effect.runPromise(Deferred.make<string>());
    const rightStarted = await Effect.runPromise(Deferred.make<void>());
    let rightStartedBeforeLeftResolved = false;
    let leftResolved = false;

    type LeftSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LeftNode extends NodeBase<LeftSpec> {
      static readonly spec = serviceSpec<LeftSpec>({
        tag: "services/parallel-left",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LeftSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(leftStarted, undefined);
              return yield* Deferred.await(leftGate);
            })
          ),
        }),
      });
    }

    type RightSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class RightNode extends NodeBase<RightSpec> {
      static readonly spec = serviceSpec<RightSpec>({
        tag: "services/parallel-right",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RightSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              rightStartedBeforeLeftResolved = !leftResolved;
              yield* Deferred.succeed(rightStarted, undefined);
              return "right";
            })
          ),
        }),
      });
    }

    type RootSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly left: Dep<typeof LeftNode>;
        readonly right: Dep<typeof RightNode>;
      };
      readonly result: string;
    }>;

    class RootNode extends NodeBase<RootSpec> {
      static readonly spec = resourceSpec<RootSpec>({
        tag: "resources/parallel-root",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          left: dep(LeftNode, {}),
          right: dep(RightNode, {}),
        })),
        driver: Driver.Effect<RootSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("root")),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const ready = Effect.runPromise(graph.ensureReadyNode({ spec: RootNode, args: {} }));

    await Effect.runPromise(Deferred.await(leftStarted));
    const rightStartedBeforeRelease = await Promise.race([
      Effect.runPromise(Deferred.await(rightStarted)).then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 20);
      }),
    ]);
    leftResolved = true;
    await Effect.runPromise(Deferred.succeed(leftGate, "left"));
    await ready;

    expect(rightStartedBeforeRelease).toBe(true);
    expect(rightStartedBeforeLeftResolved).toBe(true);
  });

  test("dependency readiness aggregates sibling failures after the cohort settles", async () => {
    const rightStarted = await Effect.runPromise(Deferred.make<void>());
    const rightGate = await Effect.runPromise(Deferred.make<void>());
    const leftCause = new Error("left failed");
    const rightCause = new Error("right failed");
    let acquireCount = 0;

    type LeftSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LeftNode extends NodeBase<LeftSpec> {
      static readonly spec = serviceSpec<LeftSpec>({
        tag: "services/aggregate-left",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LeftSpec>({
          acquire: Driver.Acquire(() => Effect.fail(leftCause)),
        }),
      });
    }

    type RightSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class RightNode extends NodeBase<RightSpec> {
      static readonly spec = serviceSpec<RightSpec>({
        tag: "services/aggregate-right",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RightSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(rightStarted, undefined);
              yield* Deferred.await(rightGate);
              return yield* Effect.fail(rightCause);
            })
          ),
        }),
      });
    }

    type RootSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly left: Dep<typeof LeftNode>;
        readonly right: Dep<typeof RightNode>;
      };
      readonly result: string;
    }>;

    class RootNode extends NodeBase<RootSpec> {
      static readonly spec = resourceSpec<RootSpec>({
        tag: "resources/aggregate-root",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          left: dep(LeftNode, {}),
          right: dep(RightNode, {}),
        })),
        driver: Driver.Effect<RootSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquireCount += 1;
              return "root";
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const ready = Effect.runPromise(graph.ensureReadyNode({ spec: RootNode, args: {} }));

    await Effect.runPromise(Deferred.await(rightStarted));
    const settledBeforeRight = await Promise.race([
      ready.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 20);
      }),
    ]);
    await Effect.runPromise(Deferred.succeed(rightGate, undefined));
    const handle = await ready;
    const snapshot = await Effect.runPromise(graph.snapshot());
    const root = snapshot.nodes.find((node) => node.tag === "resources/aggregate-root");
    const failure = root?.failure;

    expect(settledBeforeRight).toBe(false);
    expect(handle.status).toMatchObject({ _tag: "Wired", run: { _tag: "Error" } });
    expect(acquireCount).toBe(0);
    expect(failure).toBeInstanceOf(DependencyFailures);

    if (!(failure instanceof DependencyFailures)) {
      throw new Error("Expected aggregate dependency failure.");
    }

    expect(failure.failures).toHaveLength(2);
    expect(failure.failures.map((entry) => entry.dependency).sort()).toEqual(["left", "right"]);
    expect(
      failure.failures.map((entry) => (entry.cause as { readonly _tag?: string })._tag).sort()
    ).toEqual(["AcquireFailed", "AcquireFailed"]);
  });

  test("ensureReady accepts async driver acquire functions", async () => {
    type AsyncSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class AsyncNode extends NodeBase<AsyncSpec> {
      static readonly spec = serviceSpec<AsyncSpec>({
        tag: "services/async",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Async<AsyncSpec>({
          acquire: Driver.Acquire(async () => "async-value"),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: AsyncNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const asyncNode = snapshot.nodes.find((node) => node.tag === "services/async");

    expect(handle.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(asyncNode?.result).toBe("async-value");
  });

  test("effect driver can require Effect services supplied at execution boundary", async () => {
    const DriverValue = Context.Service<{ readonly value: string }>(
      "test/graph-execution/DriverValue"
    );
    type ServiceBackedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ServiceBackedNode extends NodeBase<ServiceBackedSpec> {
      static readonly spec = serviceSpec<ServiceBackedSpec>({
        tag: "services/effect-service-backed",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ServiceBackedSpec, typeof DriverValue>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              const service = yield* DriverValue;
              return service.value;
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph
        .ensureReadyNode({ spec: ServiceBackedNode, args: {} })
        .pipe(Effect.provideService(DriverValue, { value: "from-effect-service" }))
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/effect-service-backed");

    expect(handle.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(node?.result).toBe("from-effect-service");
  });

  test("ensureReady wraps async driver rejections as typed readiness causes", async () => {
    const cause = new TypeError("async backend failed");
    type AsyncRejectedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class AsyncRejectedNode extends NodeBase<AsyncRejectedSpec> {
      static readonly spec = serviceSpec<AsyncRejectedSpec>({
        tag: "services/async-rejected",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Async<AsyncRejectedSpec>({
          acquire: Driver.Acquire(async () => {
            throw cause;
          }),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: AsyncRejectedNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const failing = snapshot.nodes.find((node) => node.tag === "services/async-rejected");

    expect(handle.status._tag === "Wired" ? handle.status.run._tag : undefined).toBe("Error");
    expect(failing?.failure).toBeInstanceOf(AcquireFailed);

    const failure = failing?.failure as AcquireFailed | undefined;
    expect(failure?.cause).toBeInstanceOf(DriverPromiseFailed);
    expect((failure?.cause as DriverPromiseFailed | undefined)?.cause).toBe(cause);
  });

  test("ensureReady records acquire failure as run error", async () => {
    const cause = { _tag: "AcquireFailed" };
    type FailingSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FailingNode extends NodeBase<FailingSpec> {
      static readonly spec = serviceSpec<FailingSpec>({
        tag: "services/failing",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingSpec>({
          acquire: Driver.Acquire(() => Effect.fail(cause)),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: FailingNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const failing = snapshot.nodes.find((node) => node.tag === "services/failing");

    expect(handle.status._tag).toBe("Wired");
    expect(handle.status._tag === "Wired" ? handle.status.run._tag : undefined).toBe("Error");
    expect(failing?.status._tag).toBe("Wired");
    expect(failing?.failure).toBeInstanceOf(AcquireFailed);
    expect(failing?.failure).toMatchObject({
      nodeId: handle.nodeId,
      tag: "services/failing",
      cause,
    });
    expect(failing?.result).toBeUndefined();
  });

  test("failed acquire closes disposers registered before failure", async () => {
    const cause = { _tag: "AcquireRejected" };
    const cleanupCause = new Error("acquire cleanup rejected");
    const cleanupFailures: Array<{
      readonly nodeId: string;
      readonly reason: string;
      readonly failures: ReadonlyArray<unknown>;
    }> = [];
    let disposed = false;
    type FailingDisposerSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FailingDisposerNode extends NodeBase<FailingDisposerSpec> {
      static readonly spec = serviceSpec<FailingDisposerSpec>({
        tag: "services/failing-acquire-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingDisposerSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.gen(function* () {
              ctx.disposers.add(() => {
                disposed = true;
                throw cleanupCause;
              });

              return yield* Effect.fail(cause);
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(
      graph.observeCleanupFailures((nodeId, reason, failures) =>
        Effect.sync(() => {
          cleanupFailures.push({ nodeId, reason, failures });
        })
      )
    );
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: FailingDisposerNode, args: {} })
    );

    expect(handle.status._tag === "Wired" ? handle.status.run._tag : undefined).toBe("Error");
    expect(disposed).toBe(true);
    expect(cleanupFailures).toMatchObject([
      {
        nodeId: handle.nodeId,
        reason: "acquire",
        failures: [{ _tag: "DisposerFailed", cause: cleanupCause }],
      },
    ]);
    expect(cleanupFailures[0]?.failures[0]).toBeInstanceOf(DisposerFailed);
  });

  test("expired acquire closes disposers registered before expiry rejection", async () => {
    let disposed = false;
    type ExpiredDisposerSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ExpiredDisposerNode extends NodeBase<ExpiredDisposerSpec> {
      static readonly spec = serviceSpec<ExpiredDisposerSpec>({
        tag: "services/expired-acquire-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ExpiredDisposerSpec>({
          resultValidity: { _tag: "Manual" },
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              ctx.disposers.add(() => {
                disposed = true;
              });

              return resultCommit("expired", {
                validity: { _tag: "Expired", expiredAt: 1 },
              });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ExpiredDisposerNode, args: {} })
    );

    expect(handle.status._tag === "Wired" ? handle.status.run._tag : undefined).toBe("Error");
    expect(disposed).toBe(true);
  });

  test("ensureReady normalizes acquire defects as readiness errors", async () => {
    const cause = new TypeError("driver typo");
    type DefectSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class DefectNode extends NodeBase<DefectSpec> {
      static readonly spec = serviceSpec<DefectSpec>({
        tag: "services/acquire-defect",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DefectSpec>({
          acquire: Driver.Acquire(() => Effect.die(cause)),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: DefectNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const failing = snapshot.nodes.find((node) => node.tag === "services/acquire-defect");

    expect(handle.status._tag).toBe("Wired");
    expect(handle.status._tag === "Wired" ? handle.status.run._tag : undefined).toBe("Error");
    expect(failing?.failure).toBeInstanceOf(AcquireFailed);

    const failure = failing?.failure as AcquireFailed | undefined;
    expect(failure?.cause).toBeInstanceOf(EffectBoundaryFailed);
    expect((failure?.cause as EffectBoundaryFailed | undefined)?.boundary).toBe(
      "readiness-acquire"
    );
    expect((failure?.cause as EffectBoundaryFailed | undefined)?.cause).toBe(cause);
  });

  test("release closes registered disposers", async () => {
    let disposed = false;
    type DisposableSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class DisposableNode extends NodeBase<DisposableSpec> {
      static readonly spec = serviceSpec<DisposableSpec>({
        tag: "services/disposable",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DisposableSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              ctx.disposers.add(() => {
                disposed = true;
              });

              return "disposable";
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DisposableNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));

    const snapshot = await Effect.runPromise(graph.snapshot());
    const disposable = snapshot.nodes.find((node) => node.tag === "services/disposable");

    expect(disposed).toBe(true);
    expect(disposable?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(disposable?.result).toBeUndefined();
  });

  test("release closes disposers registered by release hook", async () => {
    let disposed = false;
    type ReleaseDisposableSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseDisposableNode extends NodeBase<ReleaseDisposableSpec> {
      static readonly spec = serviceSpec<ReleaseDisposableSpec>({
        tag: "services/release-disposable",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleaseDisposableSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("disposable")),
          release: Driver.Release((ctx) =>
            Effect.sync(() => {
              ctx.disposers.add(() => {
                disposed = true;
              });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReleaseDisposableNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));

    expect(disposed).toBe(true);
  });

  test("failed release closes disposers registered by release hook", async () => {
    const cause = { _tag: "ReleaseRejected" };
    let disposed = false;
    type ReleaseFailingDisposerSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseFailingDisposerNode extends NodeBase<ReleaseFailingDisposerSpec> {
      static readonly spec = serviceSpec<ReleaseFailingDisposerSpec>({
        tag: "services/release-failing-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleaseFailingDisposerSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("disposable")),
          release: Driver.Release((ctx) =>
            Effect.gen(function* () {
              ctx.disposers.add(() => {
                disposed = true;
              });

              return yield* Effect.fail(cause);
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReleaseFailingDisposerNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/release-failing-disposer");
    const failure = node?.failure;

    expect(disposed).toBe(true);
    expect(failure).toBeInstanceOf(DisposerFailed);
    expect(failure).toMatchObject({ cause });
  });

  test("pending readiness keeps one stable attempt", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<string>());
    type SlowSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SlowNode extends NodeBase<SlowSpec> {
      static readonly spec = serviceSpec<SlowSpec>({
        tag: "services/slow",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const first = Effect.runPromise(graph.ensureReadyNode({ spec: SlowNode, args: {} }));
    await Effect.runPromise(Deferred.await(started));

    const pendingSnapshot = await Effect.runPromise(graph.snapshot());
    const pending = pendingSnapshot.nodes.find((node) => node.tag === "services/slow");
    const second = Effect.runPromise(graph.ensureReadyNode({ spec: SlowNode, args: {} }));
    const stillPendingSnapshot = await Effect.runPromise(graph.snapshot());
    const stillPending = stillPendingSnapshot.nodes.find((node) => node.tag === "services/slow");

    expect(pending?.status).toEqual({ _tag: "Wired", run: { _tag: "Pending", attemptId: 1 } });
    expect(stillPending?.status).toEqual({
      _tag: "Wired",
      run: { _tag: "Pending", attemptId: 1 },
    });

    await Effect.runPromise(Deferred.succeed(gate, "slow"));

    const [firstHandle, secondHandle] = await Promise.all([first, second]);

    expect(firstHandle).toEqual(secondHandle);
    expect(firstHandle.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
  });

  test("concurrent ensureReady calls for one node create one acquire attempt", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<string>());
    let acquireCount = 0;
    type SlowSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SlowNode extends NodeBase<SlowSpec> {
      static readonly spec = serviceSpec<SlowSpec>({
        tag: "services/one-acquire",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              acquireCount += 1;
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const first = Effect.runPromise(graph.ensureReadyNode({ spec: SlowNode, args: {} }));
    await Effect.runPromise(Deferred.await(started));
    const second = Effect.runPromise(graph.ensureReadyNode({ spec: SlowNode, args: {} }));

    await Effect.runPromise(Deferred.succeed(gate, "ready"));
    const [firstHandle, secondHandle] = await Promise.all([first, second]);

    expect(acquireCount).toBe(1);
    expect(firstHandle).toEqual(secondHandle);
    expect(firstHandle.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
  });

  test("release submitted during an action waits and then disposes", async () => {
    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    const actionGate = await Effect.runPromise(Deferred.make<void>());
    let disposed = false;
    type ReleasableSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { count: number };
      readonly actions: {
        readonly increment: ActionContract<void, void>;
      };
    }>;

    class ReleasableNode extends NodeBase<ReleasableSpec> {
      static readonly spec = resourceSpec<ReleasableSpec>({
        tag: "resources/release-during-action",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleasableSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              ctx.disposers.add(() => {
                disposed = true;
              });
              return { count: 0 };
            })
          ),
          actions: {
            increment: Driver.Action((ctx) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(actionStarted, undefined);
                yield* Deferred.await(actionGate);
                yield* ctx.patchResult((current) => {
                  current.count += 1;
                });
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReleasableNode, args: {} })
    );
    const action = Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeId", nodeId: handle.nodeId },
        action: "increment",
        input: undefined,
      })
    );
    await Effect.runPromise(Deferred.await(actionStarted));
    const release = Effect.runPromise(graph.releaseNode(handle.nodeId));

    expect(disposed).toBe(false);
    await Effect.runPromise(Deferred.succeed(actionGate, undefined));
    await Promise.all([action, release]);
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/release-during-action");

    expect(disposed).toBe(true);
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.result).toBeUndefined();
  });

  test("GraphSystem.stop shuts down cell actors and releases active resources", async () => {
    let disposed = false;
    type StopSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class StopNode extends NodeBase<StopSpec> {
      static readonly spec = serviceSpec<StopSpec>({
        tag: "services/stop-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<StopSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              ctx.disposers.add(() => {
                disposed = true;
              });
              return "ready";
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: StopNode, args: {} }));
    await Effect.runPromise(graph.stop());
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/stop-release");

    expect(disposed).toBe(true);
    expect(snapshot.status).toBe("stopped");
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.result).toBeUndefined();
  });

  test("GraphSystem.stop interrupts active cell work", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    type HangingSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class HangingNode extends NodeBase<HangingSpec> {
      static readonly spec = serviceSpec<HangingSpec>({
        tag: "services/hanging-stop",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<HangingSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const ready = Effect.runPromise(graph.ensureReadyNode({ spec: HangingNode, args: {} }));
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(graph.stop().pipe(Effect.timeout("100 millis")));
    const interrupted = await ready;
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/hanging-stop");
    const error =
      interrupted.status._tag === "Wired" && interrupted.status.run._tag === "Error"
        ? interrupted.status.run.error
        : undefined;

    expect(error).toBeInstanceOf(NodeEvicted);
    expect(error).toMatchObject({
      cancellation: { _tag: "RuntimeStopped" },
    });
    expect(snapshot.status).toBe("stopped");
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
  });

  test("release failures are recorded on the graph snapshot", async () => {
    const cause = { _tag: "ReleaseRejected" };
    type ReleaseFailSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseFailNode extends NodeBase<ReleaseFailSpec> {
      static readonly spec = serviceSpec<ReleaseFailSpec>({
        tag: "services/release-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleaseFailSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() => Effect.fail(cause)),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReleaseFailNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/release-failure");

    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.failure).toBeInstanceOf(DisposerFailed);
    expect(node?.failure).toMatchObject({ cause });
  });

  test("release defects preserve Effect cause in cleanup failure", async () => {
    const cause = new TypeError("release died");
    type ReleaseDefectSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseDefectNode extends NodeBase<ReleaseDefectSpec> {
      static readonly spec = serviceSpec<ReleaseDefectSpec>({
        tag: "services/release-defect",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReleaseDefectSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
          release: Driver.Release(() => Effect.die(cause)),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReleaseDefectNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/release-defect");
    const failure = node?.failure;
    const boundary = failure instanceof DisposerFailed ? failure.cause : undefined;

    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(failure).toBeInstanceOf(DisposerFailed);
    expect(boundary).toBeInstanceOf(EffectBoundaryFailed);
    expect((boundary as EffectBoundaryFailed | undefined)?.boundary).toBe("driver-release");
    expect((boundary as EffectBoundaryFailed | undefined)?.cause).toBe(cause);
  });

  test("disposer failures are recorded on the graph snapshot", async () => {
    const cause = new Error("dispose rejected");
    type DisposerFailSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class DisposerFailNode extends NodeBase<DisposerFailSpec> {
      static readonly spec = serviceSpec<DisposerFailSpec>({
        tag: "services/disposer-failure",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DisposerFailSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              ctx.disposers.add(() => {
                throw cause;
              });
              return "ready";
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DisposerFailNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/disposer-failure");

    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.failure).toBeInstanceOf(DisposerFailed);
    expect(node?.failure).toMatchObject({ cause });
  });

  test("cleanup snapshot preserves the first failure in execution order", async () => {
    const releaseCause = new Error("release failed first");
    const disposerCause = new Error("disposer failed second");
    type CleanupOrderSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class CleanupOrderNode extends NodeBase<CleanupOrderSpec> {
      static readonly spec = serviceSpec<CleanupOrderSpec>({
        tag: "services/cleanup-failure-order",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<CleanupOrderSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => {
              ctx.disposers.add(() => {
                throw disposerCause;
              });
              return "ready";
            })
          ),
          release: Driver.Release(() => Effect.fail(releaseCause)),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: CleanupOrderNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(handle.nodeId));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/cleanup-failure-order");

    expect(node?.failure).toBeInstanceOf(DisposerFailed);
    expect(node?.failure).toMatchObject({ cause: releaseCause });
  });
});
