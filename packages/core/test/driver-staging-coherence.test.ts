import { describe, expect, test } from "bun:test";
import { Cause } from "effect";
import { FrondNodeSpecError } from "../src/node";
import {
  AcquireFailed,
  type ActionContract,
  ActionFailed,
  type Dep,
  Driver,
  DriverOperationTimedOut,
  DriverPromiseFailed,
  dep,
  dependencies,
  Effect,
  GraphInvariantViolation,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  ReleaseFailed,
  resourceSpec,
  serviceSpec,
} from "./graphTestFixtures";

describe("driver staging coherence", () => {
  test("acquire stages result and validity when the hook does not return a value", async () => {
    const graph = makeInMemoryGraphSystem();
    const ready = await Effect.runPromise(
      graph.ensureReadyNode({ spec: AcquireStagedWithoutReturnNode, args: {} })
    );

    expect(ready).toMatchObject({
      _tag: "Ready",
      resultValidity: { _tag: "Stale", staleAt: 10 },
    });
    expect((ready.node as AcquireStagedWithoutReturnNode).result).toEqual({
      value: "staged",
    });
  });

  test("acquire return value supersedes staged result value but not staged validity", async () => {
    const graph = makeInMemoryGraphSystem();
    const ready = await Effect.runPromise(
      graph.ensureReadyNode({ spec: AcquireReturnPrecedenceNode, args: {} })
    );

    expect(ready).toMatchObject({
      _tag: "Ready",
      resultValidity: { _tag: "Stale", staleAt: 10 },
    });
    expect((ready.node as AcquireReturnPrecedenceNode).result).toEqual({
      value: "returned",
    });
  });

  test("refresh returns and commits the staged result when the hook does not return a value", async () => {
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(
      graph.ensureReadyNode({ spec: RefreshStagedWithoutReturnNode, args: {} })
    );
    const refresh = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: RefreshStagedWithoutReturnNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "staging/refresh-staged");

    expect(refresh).toMatchObject({
      _tag: "Success",
      value: { value: "staged" },
    });
    expect(node).toMatchObject({
      result: { value: "staged" },
      resultValidity: { _tag: "Stale", staleAt: 20 },
    });
  });

  test("refresh return value supersedes staged result value but not staged validity", async () => {
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(graph.ensureReadyNode({ spec: RefreshReturnPrecedenceNode, args: {} }));
    const refresh = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: RefreshReturnPrecedenceNode, args: {} },
        },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "staging/refresh-return");

    expect(refresh).toMatchObject({
      _tag: "Success",
      value: { value: "returned" },
    });
    expect(node).toMatchObject({
      result: { value: "returned" },
      resultValidity: { _tag: "Stale", staleAt: 20 },
    });
  });

  test("action commits staged result and validity when the hook does not return a value", async () => {
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(
      graph.ensureReadyNode({ spec: ActionStagedWithoutReturnNode, args: {} })
    );
    const action = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionStagedWithoutReturnNode, args: {} },
        },
        action: "stage",
        input: undefined,
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "staging/action-staged");

    expect(action).toMatchObject({ _tag: "Success", value: undefined });
    expect(node).toMatchObject({
      result: { value: "staged" },
      resultValidity: { _tag: "Stale", staleAt: 30 },
    });
  });

  test("action output is returned to caller and never committed as node result", async () => {
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(graph.ensureReadyNode({ spec: ActionOutputOnlyNode, args: {} }));
    const action = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionOutputOnlyNode, args: {} },
        },
        action: "count",
        input: undefined,
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "staging/action-output-only");

    expect(action).toMatchObject({ _tag: "Success", value: 3 });
    expect(node).toMatchObject({
      result: { value: "initial" },
    });
  });

  test("action output is returned while staged result and validity commit", async () => {
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(
      graph.ensureReadyNode({ spec: ActionOutputWithStagedResultNode, args: {} })
    );
    const action = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionOutputWithStagedResultNode, args: {} },
        },
        action: "stage",
        input: undefined,
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "staging/action-output-staged");

    expect(action).toMatchObject({ _tag: "Success", value: { value: "returned" } });
    expect(node).toMatchObject({
      result: { value: "staged" },
      resultValidity: { _tag: "Stale", staleAt: 30 },
    });
  });

  test("explicit stale and expired commits are visible under TimeBound on read, refresh, dependency, and snapshot paths", async () => {
    timeBoundSourceAcquireRuns = 0;
    timeBoundSourceRefreshRuns = 0;
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: TimeBoundSourceNode, args: {} }));
    await Effect.runPromise(graph.ensureReadyNode({ spec: TimeBoundDependentNode, args: {} }));
    await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: TimeBoundSourceNode, args: {} },
        },
        action: "stale",
        input: undefined,
      })
    );
    const staleSnapshot = await Effect.runPromise(graph.snapshot());
    const staleSource = staleSnapshot.nodes.find(
      (entry) => entry.tag === "staging/time-bound-source"
    );

    expect(staleSource).toMatchObject({ resultValidity: { _tag: "Stale", staleAt: 40 } });

    await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: TimeBoundSourceNode, args: {} },
        },
        action: "expire",
        input: undefined,
      })
    );

    const expiredSnapshot = await Effect.runPromise(graph.snapshot());
    const expiredSource = expiredSnapshot.nodes.find(
      (entry) => entry.tag === "staging/time-bound-source"
    );
    const refresh = await Effect.runPromise(
      graph.refreshNode({
        target: {
          _tag: "NodeRequest",
          request: { spec: TimeBoundSourceNode, args: {} },
        },
      })
    );
    const dependencyAction = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: TimeBoundDependentNode, args: {} },
        },
        action: "readSource",
        input: undefined,
      })
    );

    expect(expiredSource).toMatchObject({ resultValidity: { _tag: "Expired", expiredAt: 50 } });
    expect(refresh).toMatchObject({
      _tag: "Failure",
      error: { _tag: "RefreshFailed", cause: { _tag: "ResultExpired" } },
    });
    expect(timeBoundSourceRefreshRuns).toBe(0);
    expect(dependencyAction).toMatchObject({
      _tag: "Failure",
      error: {
        _tag: "ActionFailed",
        cause: {
          _tag: "DependencyFailed",
          cause: { _tag: "DependencyResultExpired" },
        },
      },
    });

    const invalidated = await Effect.runPromise(
      graph.ensureReadyNode({ spec: TimeBoundSourceNode, args: {} })
    );

    expect(invalidated).toMatchObject({
      _tag: "Ready",
      resultValidity: { _tag: "Current" },
    });
    expect((invalidated.node as TimeBoundSourceNode).result).toEqual({
      value: "source:2",
    });
    expect(timeBoundSourceAcquireRuns).toBe(2);
  });

  test("patchResult on a class result fails loudly without non-plain opt-in", async () => {
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(graph.ensureReadyNode({ spec: ClassPatchRejectedNode, args: {} }));
    const action = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ClassPatchRejectedNode, args: {} },
        },
        action: "mutate",
        input: undefined,
      })
    );

    expect(action._tag).toBe("Failure");
    const failure = action._tag === "Failure" ? action.error : undefined;
    const boundary = failure instanceof ActionFailed ? failure.cause : undefined;
    expect(boundary).toBeInstanceOf(DriverPromiseFailed);
    expect((boundary as DriverPromiseFailed | undefined)?.cause).toBeInstanceOf(
      GraphInvariantViolation
    );
  });

  test("patchResult non-plain opt-in keeps documented shared-reference semantics", async () => {
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(graph.ensureReadyNode({ spec: ClassPatchSharedNode, args: {} }));
    const action = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ClassPatchSharedNode, args: {} },
        },
        action: "mutateThenFail",
        input: undefined,
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "staging/class-patch-shared");

    expect(action).toMatchObject({ _tag: "Failure" });
    expect((node?.result as PatchBox | undefined)?.value).toBe(1);
  });

  test("unwrapped hook descriptors fail loudly at driver construction", () => {
    expect(() =>
      Driver.Async({
        acquire: (() => "ready") as never,
      })
    ).toThrow(FrondNodeSpecError);

    expect(() =>
      Driver.Effect({
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
        refresh: (() => Effect.void) as never,
      })
    ).toThrow(FrondNodeSpecError);
  });

  test("driver-raised timeout and graph-imposed operation timeout stay distinguishable", async () => {
    const driverTimeoutGraph = makeInMemoryGraphSystem({ driverTimeouts: { acquire: 1_000 } });
    const driverTimeoutRead = await Effect.runPromise(
      driverTimeoutGraph.ensureReadyNode({ spec: DriverTimeoutNode, args: {} })
    );
    const driverFailure =
      driverTimeoutRead.status._tag === "Wired" && driverTimeoutRead.status.run._tag === "Error"
        ? driverTimeoutRead.status.run.error
        : undefined;
    const driverCause = driverFailure instanceof AcquireFailed ? driverFailure.cause : undefined;

    expect(Cause.isTimeoutError(driverCause)).toBe(true);
    expect(driverCause).not.toBeInstanceOf(DriverOperationTimedOut);

    const operationTimeoutGraph = makeInMemoryGraphSystem({ driverTimeouts: { acquire: 5 } });
    const operationTimeoutRead = await Effect.runPromise(
      operationTimeoutGraph.ensureReadyNode({ spec: OperationTimeoutNode, args: {} })
    );
    const operationFailure =
      operationTimeoutRead.status._tag === "Wired" &&
      operationTimeoutRead.status.run._tag === "Error"
        ? operationTimeoutRead.status.run.error
        : undefined;
    const operationCause =
      operationFailure instanceof AcquireFailed ? operationFailure.cause : undefined;

    expect(operationCause).toBeInstanceOf(DriverOperationTimedOut);
  });

  test("effect-mode release hook failure uses release-origin taxonomy", async () => {
    const cause = { _tag: "ReleaseRejected" };
    const graph = makeInMemoryGraphSystem();

    const ready = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReleaseFailureNode, args: {} })
    );
    await Effect.runPromise(graph.releaseNode(ready.nodeId));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "staging/release-failure");

    expect(node?.failure).toBeInstanceOf(ReleaseFailed);
    expect(node?.failure).toMatchObject({ cause });
  });
});

type ResultShape = { readonly value: string };

type AcquireStagedSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: ResultShape;
}>;

class AcquireStagedWithoutReturnNode extends NodeBase<AcquireStagedSpec> {
  static readonly spec = serviceSpec<AcquireStagedSpec>({
    tag: "staging/acquire-staged",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<AcquireStagedSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire((ctx) =>
        Effect.gen(function* () {
          yield* ctx.setResult({ value: "staged" });
          yield* ctx.setResultValidity({ _tag: "Stale", staleAt: 10 });
          return undefined as never;
        })
      ),
    }),
  });
}

class AcquireReturnPrecedenceNode extends NodeBase<AcquireStagedSpec> {
  static readonly spec = serviceSpec<AcquireStagedSpec>({
    tag: "staging/acquire-return",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<AcquireStagedSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire((ctx) =>
        Effect.gen(function* () {
          yield* ctx.setResult({ value: "staged" });
          yield* ctx.setResultValidity({ _tag: "Stale", staleAt: 10 });
          return { value: "returned" };
        })
      ),
    }),
  });
}

type RefreshStagingSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: ResultShape;
}>;

class RefreshStagedWithoutReturnNode extends NodeBase<RefreshStagingSpec> {
  static readonly spec = serviceSpec<RefreshStagingSpec>({
    tag: "staging/refresh-staged",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<RefreshStagingSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
      refresh: Driver.Refresh((ctx) =>
        Effect.gen(function* () {
          yield* ctx.setResult({ value: "staged" });
          yield* ctx.setResultValidity({ _tag: "Stale", staleAt: 20 });
        })
      ),
    }),
  });
}

class RefreshReturnPrecedenceNode extends NodeBase<RefreshStagingSpec> {
  static readonly spec = serviceSpec<RefreshStagingSpec>({
    tag: "staging/refresh-return",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<RefreshStagingSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
      refresh: Driver.Refresh((ctx) =>
        Effect.gen(function* () {
          yield* ctx.setResult({ value: "staged" });
          yield* ctx.setResultValidity({ _tag: "Stale", staleAt: 20 });
          return { value: "returned" } as never;
        })
      ),
    }),
  });
}

type ActionStagingSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: ResultShape;
  readonly actions: {
    readonly stage: ActionContract<void, ResultShape | undefined>;
  };
}>;

class ActionStagedWithoutReturnNode extends NodeBase<ActionStagingSpec> {
  static readonly spec = serviceSpec<ActionStagingSpec>({
    tag: "staging/action-staged",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ActionStagingSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
      actions: {
        stage: Driver.Action((ctx) =>
          Effect.gen(function* () {
            yield* ctx.setResult({ value: "staged" });
            yield* ctx.setResultValidity({ _tag: "Stale", staleAt: 30 });
          })
        ),
      },
    }),
  });
}

type ActionOutputOnlySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: ResultShape;
  readonly actions: {
    readonly count: ActionContract<void, number>;
  };
}>;

class ActionOutputOnlyNode extends NodeBase<ActionOutputOnlySpec> {
  static readonly spec = serviceSpec<ActionOutputOnlySpec>({
    tag: "staging/action-output-only",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ActionOutputOnlySpec>({
      acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
      actions: {
        count: Driver.Action(() => Effect.succeed(3)),
      },
    }),
  });
}

class ActionOutputWithStagedResultNode extends NodeBase<ActionStagingSpec> {
  static readonly spec = serviceSpec<ActionStagingSpec>({
    tag: "staging/action-output-staged",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ActionStagingSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
      actions: {
        stage: Driver.Action((ctx) =>
          Effect.gen(function* () {
            yield* ctx.setResult({ value: "staged" });
            yield* ctx.setResultValidity({ _tag: "Stale", staleAt: 30 });
            return { value: "returned" };
          })
        ),
      },
    }),
  });
}

let timeBoundSourceAcquireRuns = 0;
let timeBoundSourceRefreshRuns = 0;

type TimeBoundSourceSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: ResultShape;
  readonly actions: {
    readonly stale: ActionContract<void, void>;
    readonly expire: ActionContract<void, void>;
  };
}>;

class TimeBoundSourceNode extends NodeBase<TimeBoundSourceSpec> {
  static readonly spec = serviceSpec<TimeBoundSourceSpec>({
    tag: "staging/time-bound-source",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<TimeBoundSourceSpec>({
      resultValidity: {
        _tag: "TimeBound",
        staleAfter: "10 minutes",
        expireAfter: "20 minutes",
      },
      acquire: Driver.Acquire(() =>
        Effect.sync(() => {
          timeBoundSourceAcquireRuns += 1;
          return { value: `source:${timeBoundSourceAcquireRuns}` };
        })
      ),
      refresh: Driver.Refresh(() =>
        Effect.sync(() => {
          timeBoundSourceRefreshRuns += 1;
        })
      ),
      actions: {
        stale: Driver.Action((ctx) => ctx.setResultValidity({ _tag: "Stale", staleAt: 40 })),
        expire: Driver.Action((ctx) => ctx.setResultValidity({ _tag: "Expired", expiredAt: 50 })),
      },
    }),
  });
}

type TimeBoundDependentSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly source: Dep<typeof TimeBoundSourceNode>;
  };
  readonly result: ResultShape;
  readonly actions: {
    readonly readSource: ActionContract<void, void>;
  };
}>;

class TimeBoundDependentNode extends NodeBase<TimeBoundDependentSpec> {
  static readonly spec = resourceSpec<TimeBoundDependentSpec>({
    tag: "staging/time-bound-dependent",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      source: dep(TimeBoundSourceNode, {}),
    })),
    driver: Driver.Effect<TimeBoundDependentSpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.succeed({ value: `dependent:${ctx.deps.source.result.value}` })
      ),
      actions: {
        readSource: Driver.Action((ctx) => ctx.refreshDep("source").pipe(Effect.asVoid)),
      },
    }),
  });
}

class PatchBox {
  constructor(public value: number) {}
}

type ClassPatchSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: PatchBox;
  readonly actions: {
    readonly mutate: ActionContract<void, void>;
    readonly mutateThenFail: ActionContract<void, never>;
  };
}>;

class ClassPatchRejectedNode extends NodeBase<ClassPatchSpec> {
  static readonly spec = serviceSpec<ClassPatchSpec>({
    tag: "staging/class-patch-rejected",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ClassPatchSpec>({
      acquire: Driver.Acquire(() => Effect.succeed(new PatchBox(0))),
      actions: {
        mutate: Driver.Action((ctx) =>
          ctx.patchResult((current) => {
            current.value += 1;
          })
        ),
        mutateThenFail: Driver.Action(() => Effect.fail({ _tag: "Unused" })),
      },
    }),
  });
}

class ClassPatchSharedNode extends NodeBase<ClassPatchSpec> {
  static readonly spec = serviceSpec<ClassPatchSpec>({
    tag: "staging/class-patch-shared",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ClassPatchSpec>({
      resultPatch: { nonPlainClone: "share" },
      acquire: Driver.Acquire(() => Effect.succeed(new PatchBox(0))),
      actions: {
        mutate: Driver.Action((ctx) =>
          ctx.patchResult((current) => {
            current.value += 1;
          })
        ),
        mutateThenFail: Driver.Action((ctx) =>
          Effect.gen(function* () {
            yield* ctx.patchResult((current) => {
              current.value += 1;
            });
            return yield* Effect.fail({ _tag: "AfterPatchFailure" });
          })
        ),
      },
    }),
  });
}

type TimeoutSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class DriverTimeoutNode extends NodeBase<TimeoutSpec> {
  static readonly spec = serviceSpec<TimeoutSpec>({
    tag: "staging/driver-timeout",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<TimeoutSpec>({
      acquire: Driver.Acquire(() => Effect.sleep("20 millis").pipe(Effect.timeout("1 millis"))),
    }),
  });
}

class OperationTimeoutNode extends NodeBase<TimeoutSpec> {
  static readonly spec = serviceSpec<TimeoutSpec>({
    tag: "staging/operation-timeout",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<TimeoutSpec>({
      acquire: Driver.Acquire(() => Effect.sleep("50 millis").pipe(Effect.as("ready"))),
    }),
  });
}

class ReleaseFailureNode extends NodeBase<TimeoutSpec> {
  static readonly spec = serviceSpec<TimeoutSpec>({
    tag: "staging/release-failure",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<TimeoutSpec>({
      acquire: Driver.Acquire(() => Effect.succeed("ready")),
      release: Driver.Release(() => Effect.fail({ _tag: "ReleaseRejected" })),
    }),
  });
}
