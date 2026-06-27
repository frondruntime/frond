import { describe, expect, test } from "bun:test";
import {
  type ActionContract,
  ActionProfileNode,
  Deferred,
  type Dep,
  DependencyFailures,
  DependencyRefreshFailed,
  Driver,
  DriverOperationTimedOut,
  dep,
  dependencies,
  Effect,
  EffectBoundaryFailed,
  GraphInvariantViolation,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  RefreshFailed,
  resourceSpec,
  serviceSpec,
} from "./graphTestFixtures";

describe("graph refresh", () => {
  test("refresh updates a ready node while keeping readiness state", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ActionProfileNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionProfileNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/action-profile");

    expect(result._tag).toBe("Success");
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(node?.result).toEqual({ name: "transport", timezone: "REFRESHED" });
  });

  test("refresh rejects idle nodes without acquiring them", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureNode({ spec: ActionProfileNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionProfileNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/action-profile");

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.error : undefined).toBeInstanceOf(RefreshFailed);
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(node?.result).toBeUndefined();
  });

  test("missing refresh is a no-op success for ready nodes", async () => {
    type NoopRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class NoopRefreshNode extends NodeBase<NoopRefreshSpec> {
      static readonly spec = resourceSpec<NoopRefreshSpec>({
        tag: "resources/noop-refresh",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<NoopRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: NoopRefreshNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: NoopRefreshNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/noop-refresh");

    expect(result).toEqual({
      _tag: "Success",
      nodeId: node?.nodeId,
      value: { value: "stable" },
    });
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(node?.operation).toEqual({ _tag: "Idle" });
    expect(node?.operationFailure).toBeUndefined();
    expect(node?.result).toEqual({ value: "stable" });
  });

  test("refresh does not propagate to dependencies unless the driver asks for it", async () => {
    let childRefreshes = 0;
    type ChildSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: number };
    }>;

    class ChildNode extends NodeBase<ChildSpec> {
      static readonly spec = serviceSpec<ChildSpec>({
        tag: "services/no-implicit-refresh-child",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ChildSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: 0 })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              childRefreshes += 1;
              yield* ctx.setResult({ value: childRefreshes });
            })
          ),
        }),
      });
    }

    type ParentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly child: Dep<typeof ChildNode>;
      };
      readonly result: { readonly value: string };
    }>;

    class ParentNode extends NodeBase<ParentSpec> {
      static readonly spec = resourceSpec<ParentSpec>({
        tag: "resources/no-implicit-refresh-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          child: dep(ChildNode, {}),
        })),
        driver: Driver.Effect<ParentSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed({ value: `parent:${ctx.deps.child.result.value}` })
          ),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* ctx.setResult({ value: "parent-only" });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: ParentNode, args: {} } },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const child = snapshot.nodes.find(
      (entry) => entry.tag === "services/no-implicit-refresh-child"
    );
    const parent = snapshot.nodes.find(
      (entry) => entry.tag === "resources/no-implicit-refresh-parent"
    );

    expect(result._tag).toBe("Success");
    expect(childRefreshes).toBe(0);
    expect(child?.result).toEqual({ value: 0 });
    expect(parent?.result).toEqual({ value: "parent-only" });
  });

  test("driver refreshDep refreshes one direct dependency and returns the refreshed node", async () => {
    let childRefreshes = 0;
    type ChildSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: number };
    }>;

    class ChildNode extends NodeBase<ChildSpec> {
      static readonly spec = serviceSpec<ChildSpec>({
        tag: "services/explicit-refresh-child",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ChildSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: 0 })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              childRefreshes += 1;
              yield* ctx.setResult({ value: childRefreshes });
            })
          ),
        }),
      });
    }

    type ParentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly child: Dep<typeof ChildNode>;
      };
      readonly result: { readonly value: string };
    }>;

    class ParentNode extends NodeBase<ParentSpec> {
      static readonly spec = resourceSpec<ParentSpec>({
        tag: "resources/explicit-refresh-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          child: dep(ChildNode, {}),
        })),
        driver: Driver.Effect<ParentSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed({ value: `parent:${ctx.deps.child.result.value}` })
          ),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              const child = yield* ctx.refreshDep("child");
              yield* ctx.setResult({ value: `parent:${child.result.value}` });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: ParentNode, args: {} } },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const child = snapshot.nodes.find((entry) => entry.tag === "services/explicit-refresh-child");
    const parent = snapshot.nodes.find(
      (entry) => entry.tag === "resources/explicit-refresh-parent"
    );

    expect(result._tag).toBe("Success");
    expect(childRefreshes).toBe(1);
    expect(child?.result).toEqual({ value: 1 });
    expect(parent?.result).toEqual({ value: "parent:1" });
  });

  test("refresh failure keeps ready result and does not set acquire failure", async () => {
    type FailingRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class FailingRefreshNode extends NodeBase<FailingRefreshSpec> {
      static readonly spec = resourceSpec<FailingRefreshSpec>({
        tag: "resources/failing-refresh",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh(() => Effect.fail({ _tag: "RefreshRejected" })),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: FailingRefreshNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: FailingRefreshNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/failing-refresh");

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.error : undefined).toBeInstanceOf(RefreshFailed);
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(node?.failure).toBeUndefined();
    expect(node?.operation).toEqual({ _tag: "Idle" });
    expect(node?.operationFailure).toMatchObject({
      kind: "refresh",
      error: { _tag: "RefreshFailed" },
    });
    expect(node?.result).toEqual({ value: "stable" });
  });

  test("refresh defects preserve Effect cause in refresh failure", async () => {
    const cause = new TypeError("refresh died");
    type DefectRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class DefectRefreshNode extends NodeBase<DefectRefreshSpec> {
      static readonly spec = resourceSpec<DefectRefreshSpec>({
        tag: "resources/refresh-defect",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DefectRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh(() => Effect.die(cause)),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: DefectRefreshNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: DefectRefreshNode, args: {} },
        },
      })
    );
    const failure = result._tag === "Failure" ? result.error : undefined;
    const boundary = failure instanceof RefreshFailed ? failure.cause : undefined;

    expect(failure).toBeInstanceOf(RefreshFailed);
    expect(boundary).toBeInstanceOf(EffectBoundaryFailed);
    expect((boundary as EffectBoundaryFailed | undefined)?.boundary).toBe("driver-refresh");
    expect((boundary as EffectBoundaryFailed | undefined)?.cause).toBe(cause);
  });

  test("refresh defect retains staged operation disposer for later release", async () => {
    const cause = new TypeError("refresh disposer defect");
    let disposed = 0;
    type DisposingRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class DisposingRefreshNode extends NodeBase<DisposingRefreshSpec> {
      static readonly spec = resourceSpec<DisposingRefreshSpec>({
        tag: "resources/refresh-defect-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DisposingRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              ctx.disposers.add(() => {
                disposed += 1;
              });
              return yield* Effect.die(cause);
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DisposingRefreshNode, args: {} })
    );

    const result = await Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeId", nodeId: handle.nodeId },
      })
    );

    expect(result._tag).toBe("Failure");
    expect(disposed).toBe(0);

    await Effect.runPromise(graph.releaseNode(handle.nodeId));

    expect(disposed).toBe(1);
  });

  test("refresh failure rolls back staged result patches", async () => {
    type FailingPatchRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { value: string };
    }>;

    class FailingPatchRefreshNode extends NodeBase<FailingPatchRefreshSpec> {
      static readonly spec = resourceSpec<FailingPatchRefreshSpec>({
        tag: "resources/failing-patch-refresh",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingPatchRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* ctx.patchResult((current) => {
                current.value = "leaked";
              });
              return yield* Effect.fail({ _tag: "RefreshRejected" });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: FailingPatchRefreshNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: FailingPatchRefreshNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/failing-patch-refresh");

    expect(result._tag).toBe("Failure");
    expect(node?.result).toEqual({ value: "stable" });
  });

  test("pending refresh exposes operation state while keeping ready result", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    type SlowRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class SlowRefreshNode extends NodeBase<SlowRefreshSpec> {
      static readonly spec = resourceSpec<SlowRefreshSpec>({
        tag: "resources/slow-refresh-operation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({ value: "fresh" });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: SlowRefreshNode, args: {} }));
    const refresh = Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: SlowRefreshNode, args: {} },
        },
      })
    );
    await Effect.runPromise(Deferred.await(refreshStarted));
    const pendingSnapshot = await Effect.runPromise(graph.snapshot());
    const pendingNode = pendingSnapshot.nodes.find(
      (entry) => entry.tag === "resources/slow-refresh-operation"
    );

    expect(pendingNode?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(pendingNode?.result).toEqual({ value: "stable" });
    expect(pendingNode?.operation).toMatchObject({ _tag: "Running", kind: "refresh" });

    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    await refresh;
    const readySnapshot = await Effect.runPromise(graph.snapshot());
    const readyNode = readySnapshot.nodes.find(
      (entry) => entry.tag === "resources/slow-refresh-operation"
    );

    expect(readyNode?.operation).toEqual({ _tag: "Idle" });
    expect(readyNode?.operationFailure).toBeUndefined();
    expect(readyNode?.result).toEqual({ value: "fresh" });
  });

  test("concurrent refresh submissions for one node join the active refresh", async () => {
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
        tag: "resources/refresh-singleflight",
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
    const request = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: SlowRefreshNode, args: {} },
      },
    };
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: SlowRefreshNode, args: {} }));
    const first = Effect.runPromise(graph.refreshNode(request));
    await Effect.runPromise(Deferred.await(refreshStarted));
    const second = Effect.runPromise(graph.refreshNode(request));
    const third = Effect.runPromise(graph.refreshNode(request));

    expect(refreshCount).toBe(1);
    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    const results = await Promise.all([first, second, third]);
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/refresh-singleflight");

    expect(results.map((result) => result._tag)).toEqual(["Success", "Success", "Success"]);
    expect(refreshCount).toBe(1);
    expect(node?.result).toEqual({ value: "fresh:1" });
  });

  test("refresh admission reports join policy outcomes", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    type SlowRefreshSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class SlowRefreshNode extends NodeBase<SlowRefreshSpec> {
      static readonly spec = resourceSpec<SlowRefreshSpec>({
        tag: "resources/refresh-admission",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowRefreshSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({ value: "fresh" });
            })
          ),
        }),
      });
    }
    const request = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: SlowRefreshNode, args: {} },
      },
    };
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: SlowRefreshNode, args: {} }));
    const first = await Effect.runPromise(graph.submitRefreshNode(request));
    if (first._tag !== "Started") {
      throw new Error("Expected first refresh submission to start.");
    }
    const firstResult = Effect.runPromise(first.task.await);
    await Effect.runPromise(Deferred.await(refreshStarted));
    const second = await Effect.runPromise(graph.submitRefreshNode(request));

    expect(first.admission).toEqual({ policy: "join", outcome: "started" });
    expect(second.admission).toEqual({ policy: "join", outcome: "joined" });

    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    if (second._tag !== "Joined") {
      throw new Error("Expected second refresh submission to join.");
    }
    await Promise.all([firstResult, Effect.runPromise(second.task.await)]);
  });

  test("refresh after an active refresh settles starts new work", async () => {
    let refreshCount = 0;
    type RefreshAgainSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class RefreshAgainNode extends NodeBase<RefreshAgainSpec> {
      static readonly spec = resourceSpec<RefreshAgainSpec>({
        tag: "resources/refresh-again",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RefreshAgainSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              refreshCount += 1;
              yield* ctx.setResult({ value: `fresh:${refreshCount}` });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const request = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: RefreshAgainNode, args: {} },
      },
    };

    await Effect.runPromise(graph.ensureReadyNode({ spec: RefreshAgainNode, args: {} }));
    const first = await Effect.runPromise(graph.refreshNode(request));
    const second = await Effect.runPromise(graph.refreshNode(request));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/refresh-again");

    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");
    expect(refreshCount).toBe(2);
    expect(node?.result).toEqual({ value: "fresh:2" });
  });

  test("coalesced refresh failure resolves every caller with one operation failure", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    let refreshCount = 0;
    type FailingSingleflightSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class FailingSingleflightNode extends NodeBase<FailingSingleflightSpec> {
      static readonly spec = resourceSpec<FailingSingleflightSpec>({
        tag: "resources/failing-refresh-singleflight",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingSingleflightSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh(() =>
            Effect.gen(function* () {
              refreshCount += 1;
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              return yield* Effect.fail({ _tag: "RefreshRejected" });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const request = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: FailingSingleflightNode, args: {} },
      },
    };

    await Effect.runPromise(graph.ensureReadyNode({ spec: FailingSingleflightNode, args: {} }));
    const first = Effect.runPromise(graph.refreshNode(request));
    await Effect.runPromise(Deferred.await(refreshStarted));
    const second = Effect.runPromise(graph.refreshNode(request));
    const third = Effect.runPromise(graph.refreshNode(request));

    expect(refreshCount).toBe(1);
    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    const results = await Promise.all([first, second, third]);
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find(
      (entry) => entry.tag === "resources/failing-refresh-singleflight"
    );

    expect(results.map((result) => result._tag)).toEqual(["Failure", "Failure", "Failure"]);
    expect(refreshCount).toBe(1);
    expect(node?.operationFailure).toMatchObject({
      kind: "refresh",
      error: { _tag: "RefreshFailed" },
    });
  });

  test("refresh coalescing is scoped per node identity", async () => {
    const startedA = await Effect.runPromise(Deferred.make<void>());
    const startedB = await Effect.runPromise(Deferred.make<void>());
    const gateA = await Effect.runPromise(Deferred.make<void>());
    const gateB = await Effect.runPromise(Deferred.make<void>());
    const refreshCounts = new Map<string, number>();
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    type MultiRefreshSpec = NodeSpec<{
      readonly args: { readonly id: string };
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class MultiRefreshNode extends NodeBase<MultiRefreshSpec> {
      static readonly spec = resourceSpec<MultiRefreshSpec>({
        tag: "resources/per-node-refresh-singleflight",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<MultiRefreshSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed({
              value: ctx.args.id,
            })
          ),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              const id = ctx.args.id;
              refreshCounts.set(id, (refreshCounts.get(id) ?? 0) + 1);
              activeRefreshes += 1;
              maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
              yield* Deferred.succeed(id === "a" ? startedA : startedB, undefined);
              yield* Deferred.await(id === "a" ? gateA : gateB);
              yield* ctx.setResult({ value: `fresh:${id}` });
              activeRefreshes -= 1;
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const requestA = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: MultiRefreshNode, args: { id: "a" } },
      },
    };
    const requestB = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: MultiRefreshNode, args: { id: "b" } },
      },
    };

    await Promise.all([
      Effect.runPromise(graph.ensureReadyNode({ spec: MultiRefreshNode, args: { id: "a" } })),
      Effect.runPromise(graph.ensureReadyNode({ spec: MultiRefreshNode, args: { id: "b" } })),
    ]);
    const firstA = Effect.runPromise(graph.refreshNode(requestA));
    const firstB = Effect.runPromise(graph.refreshNode(requestB));
    await Promise.all([
      Effect.runPromise(Deferred.await(startedA)),
      Effect.runPromise(Deferred.await(startedB)),
    ]);
    const secondA = Effect.runPromise(graph.refreshNode(requestA));
    const secondB = Effect.runPromise(graph.refreshNode(requestB));

    expect(refreshCounts.get("a")).toBe(1);
    expect(refreshCounts.get("b")).toBe(1);
    expect(maxActiveRefreshes).toBe(2);
    await Promise.all([
      Effect.runPromise(Deferred.succeed(gateA, undefined)),
      Effect.runPromise(Deferred.succeed(gateB, undefined)),
    ]);
    const results = await Promise.all([firstA, secondA, firstB, secondB]);

    expect(results.map((result) => result._tag)).toEqual([
      "Success",
      "Success",
      "Success",
      "Success",
    ]);
    expect(refreshCounts.get("a")).toBe(1);
    expect(refreshCounts.get("b")).toBe(1);
  });

  test("refresh serializes with actions on the same node", async () => {
    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    const actionGate = await Effect.runPromise(Deferred.make<void>());
    const order: Array<string> = [];
    type RefreshOrderSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { value: string };
      readonly actions: {
        readonly slow: ActionContract<void, void>;
      };
    }>;

    class RefreshOrderNode extends NodeBase<RefreshOrderSpec> {
      static readonly spec = resourceSpec<RefreshOrderSpec>({
        tag: "resources/refresh-order",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RefreshOrderSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              order.push("refresh");
              yield* ctx.patchResult((current) => {
                current.value = "refresh";
              });
            })
          ),
          actions: {
            slow: Driver.Action((ctx) =>
              Effect.gen(function* () {
                order.push("action");
                yield* Deferred.succeed(actionStarted, undefined);
                yield* Deferred.await(actionGate);
                yield* ctx.patchResult((current) => {
                  current.value = "action";
                });
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: RefreshOrderNode, args: {} }));
    const action = Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: RefreshOrderNode, args: {} },
        },
        action: "slow",
        input: undefined,
      })
    );
    await Effect.runPromise(Deferred.await(actionStarted));
    const refresh = Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: RefreshOrderNode, args: {} },
        },
      })
    );

    await Effect.runPromise(Deferred.succeed(actionGate, undefined));
    await Promise.all([action, refresh]);
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/refresh-order");

    expect(order).toEqual(["action", "refresh"]);
    expect(node?.result).toEqual({ value: "refresh" });
  });

  test("driver refreshDep uses refresh admission for shared dependency refreshes", async () => {
    const childStarted = await Effect.runPromise(Deferred.make<void>());
    const childGate = await Effect.runPromise(Deferred.make<void>());
    let childRefreshes = 0;

    type ChildSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: number };
    }>;

    class ChildNode extends NodeBase<ChildSpec> {
      static readonly spec = serviceSpec<ChildSpec>({
        tag: "services/refresh-dep-admission-child",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ChildSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: 0 })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              childRefreshes += 1;
              yield* Deferred.succeed(childStarted, undefined);
              yield* Deferred.await(childGate);
              yield* ctx.setResult({ value: childRefreshes });
            })
          ),
        }),
      });
    }

    type ParentSpec = NodeSpec<{
      readonly args: { readonly id: string };
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: {
        readonly child: Dep<typeof ChildNode>;
      };
      readonly result: { readonly value: string };
    }>;

    class ParentNode extends NodeBase<ParentSpec> {
      static readonly spec = resourceSpec<ParentSpec>({
        tag: "resources/refresh-dep-admission-parent",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({
          child: dep(ChildNode, {}),
        })),
        driver: Driver.Effect<ParentSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed({ value: `${ctx.args.id}:ready` })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              const child = yield* ctx.refreshDep("child");
              yield* ctx.setResult({ value: `${ctx.args.id}:${child.result.value}` });
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: { id: "left" } }));
    await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: { id: "right" } }));
    const left = Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: ParentNode, args: { id: "left" } } },
      })
    );
    await Effect.runPromise(Deferred.await(childStarted));
    const right = Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: ParentNode, args: { id: "right" } } },
      })
    );

    await Effect.runPromise(Deferred.succeed(childGate, undefined));
    const [leftResult, rightResult] = await Promise.all([left, right]);
    const snapshot = await Effect.runPromise(graph.snapshot());
    const parents = snapshot.nodes
      .filter((entry) => entry.tag === "resources/refresh-dep-admission-parent")
      .map((entry) => entry.result)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(leftResult._tag).toBe("Success");
    expect(rightResult._tag).toBe("Success");
    expect(childRefreshes).toBe(1);
    expect(parents).toEqual([{ value: "left:1" }, { value: "right:1" }]);
  });

  test("driver refreshDep failure becomes a dependency refresh failure", async () => {
    type ChildSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class ChildNode extends NodeBase<ChildSpec> {
      static readonly spec = serviceSpec<ChildSpec>({
        tag: "services/refresh-dep-failure-child",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ChildSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
          refresh: Driver.Refresh(() => Effect.fail({ _tag: "ChildRefreshRejected" })),
        }),
      });
    }

    type ParentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly child: Dep<typeof ChildNode>;
      };
      readonly result: { readonly value: string };
    }>;

    class ParentNode extends NodeBase<ParentSpec> {
      static readonly spec = resourceSpec<ParentSpec>({
        tag: "resources/refresh-dep-failure-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          child: dep(ChildNode, {}),
        })),
        driver: Driver.Effect<ParentSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* ctx.refreshDep("child");
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: ParentNode, args: {} } },
      })
    );
    const failure = result._tag === "Failure" ? result.error : undefined;
    const dependencyFailure = failure instanceof RefreshFailed ? failure.cause : undefined;

    expect(result._tag).toBe("Failure");
    expect(failure).toBeInstanceOf(RefreshFailed);
    expect(dependencyFailure).toBeInstanceOf(DependencyRefreshFailed);

    if (!(dependencyFailure instanceof DependencyRefreshFailed)) {
      throw new Error("Expected dependency refresh failure.");
    }

    expect(dependencyFailure.dependency).toBe("child");
    expect(dependencyFailure.cause).toBeInstanceOf(RefreshFailed);
  });

  test("driver refreshDep rejects undeclared dependency names as graph invariants", async () => {
    type ParentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class ParentNode extends NodeBase<ParentSpec> {
      static readonly spec = resourceSpec<ParentSpec>({
        tag: "resources/refresh-dep-invalid-name",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ParentSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* ctx.refreshDep("missing" as never);
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: {} }));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeRequest", request: { spec: ParentNode, args: {} } },
      })
    );
    const failure = result._tag === "Failure" ? result.error : undefined;
    const cause = failure instanceof RefreshFailed ? failure.cause : undefined;

    expect(result._tag).toBe("Failure");
    expect(failure).toBeInstanceOf(RefreshFailed);
    expect(cause).toBeInstanceOf(GraphInvariantViolation);
  });

  test("refresh dependency value collection aggregates multiple dependency failures", async () => {
    type LeftSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LeftNode extends NodeBase<LeftSpec> {
      static readonly spec = serviceSpec<LeftSpec>({
        tag: "services/refresh-aggregate-left",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LeftSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("left")),
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
        tag: "services/refresh-aggregate-right",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RightSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("right")),
        }),
      });
    }

    type ParentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly left: Dep<typeof LeftNode>;
        readonly right: Dep<typeof RightNode>;
      };
      readonly result: { readonly value: string };
    }>;

    class ParentNode extends NodeBase<ParentSpec> {
      static readonly spec = resourceSpec<ParentSpec>({
        tag: "resources/refresh-aggregate-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          left: dep(LeftNode, {}),
          right: dep(RightNode, {}),
        })),
        driver: Driver.Effect<ParentSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* ctx.patchResult(() => ({ value: "refreshed" }));
            })
          ),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const parent = await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: {} }));
    const readySnapshot = await Effect.runPromise(graph.snapshot());
    const left = readySnapshot.nodes.find((node) => node.tag === "services/refresh-aggregate-left");
    const right = readySnapshot.nodes.find(
      (node) => node.tag === "services/refresh-aggregate-right"
    );

    if (left === undefined || right === undefined) {
      throw new Error("Expected dependency nodes to be planned.");
    }

    await Effect.runPromise(graph.releaseNode(left.nodeId));
    await Effect.runPromise(graph.releaseNode(right.nodeId));
    const result = await Effect.runPromise(
      graph.refreshNode({
        target: { _tag: "NodeId", nodeId: parent.nodeId },
      })
    );
    const failure = result._tag === "Failure" ? result.error : undefined;
    const aggregate = failure instanceof RefreshFailed ? failure.cause : undefined;

    expect(result._tag).toBe("Failure");
    expect(failure).toBeInstanceOf(RefreshFailed);
    expect(aggregate).toBeInstanceOf(DependencyFailures);

    if (!(aggregate instanceof DependencyFailures)) {
      throw new Error("Expected aggregate dependency failure.");
    }

    expect(aggregate.failures).toHaveLength(2);
    expect(aggregate.failures.map((entry) => entry.dependency).sort()).toEqual(["left", "right"]);
  });

  test("refresh timeout keeps old result and records operation failure", async () => {
    type RefreshTimeoutSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class RefreshTimeoutNode extends NodeBase<RefreshTimeoutSpec> {
      static readonly spec = resourceSpec<RefreshTimeoutSpec>({
        tag: "resources/refresh-timeout",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RefreshTimeoutSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          refresh: Driver.Refresh(() => Effect.never),
        }),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { refresh: 20 },
    });

    await Effect.runPromise(graph.ensureReadyNode({ spec: RefreshTimeoutNode, args: {} }));
    const result = await Effect.runPromise(
      graph
        .refreshNode({
          target: {
            _tag: "NodeRequest",
            request: { spec: RefreshTimeoutNode, args: {} },
          },
        })
        .pipe(Effect.timeout("200 millis"))
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/refresh-timeout");
    const error = result._tag === "Failure" ? result.error : undefined;

    expect(result._tag).toBe("Failure");
    expect(error).toBeInstanceOf(RefreshFailed);
    expect(error?.cause).toBeInstanceOf(DriverOperationTimedOut);
    expect(error?.cause).toMatchObject({
      cancellation: { _tag: "TimedOut", detail: "20ms" },
    });
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(node?.result).toEqual({ value: "stable" });
    expect(node?.operationFailure).toMatchObject({
      kind: "refresh",
      error: { _tag: "RefreshFailed" },
    });
  });
});
