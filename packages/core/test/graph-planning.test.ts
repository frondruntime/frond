import { describe, expect, test } from "bun:test";
import {
  AcquireFailed,
  CycleDetected,
  createRuntime,
  Deferred,
  type Dep,
  DependencyDefinitionFailed,
  DependencyDefinitionFailures,
  Driver,
  DuplicateNodeTag,
  dep,
  dependencies,
  Effect,
  FrondRuntimeEffect,
  GraphInvariantViolation,
  Key,
  KeyBuildFailed,
  makeInMemoryGraphSystem,
  NodeBase,
  NodeConstructionFailed,
  type NodeSpec,
  ProfileNode,
  resourceSpec,
  SpecOverrideFailed,
  serviceSpec,
} from "./graphTestFixtures";

describe("graph planning", () => {
  test("same spec and args produce the same graph node id", async () => {
    const graph = makeInMemoryGraphSystem();
    const request = { spec: ProfileNode, args: {} };

    const first = await Effect.runPromise(graph.ensureNode(request));
    const second = await Effect.runPromise(graph.ensureNode(request));

    expect(second.nodeId).toBe(first.nodeId);
  });

  test("concurrent planning creates one graph identity and readiness constructs one node", async () => {
    let constructed = 0;
    type ConstructedOnceSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ConstructedOnceNode extends NodeBase<ConstructedOnceSpec, "effect"> {
      static readonly spec = serviceSpec.effect<ConstructedOnceSpec>({
        tag: "services/constructed-once",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });

      constructor() {
        super();
        constructed += 1;
      }
    }
    const graph = makeInMemoryGraphSystem();
    const request = { spec: ConstructedOnceNode, args: {} };

    const handles = await Promise.all(
      Array.from({ length: 20 }, () => Effect.runPromise(graph.ensureNode(request)))
    );
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(new Set(handles.map((handle) => handle.nodeId)).size).toBe(1);
    expect(snapshot.nodes.filter((node) => node.tag === "services/constructed-once")).toHaveLength(
      1
    );
    expect(constructed).toBe(0);

    await Effect.runPromise(graph.ensureReadyNode(request));

    expect(constructed).toBe(1);
  });

  test("ensuring a node records dependency nodes and edges once", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureNode({ spec: ProfileNode, args: {} }));
    await Effect.runPromise(graph.ensureNode({ spec: ProfileNode, args: {} }));

    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]?.dependency).toBe("transport");
    expect(snapshot.nodes.map((node) => node.tag).sort()).toEqual([
      "resources/profile",
      "services/transport",
    ]);
  });

  test("re-planning a stable node preserves dependency edges and node identity", async () => {
    // Locks the deps-equal short-circuit in recordCellDependencies: the second
    // ensureNode must not change the dependency record or the edge set.
    const graph = makeInMemoryGraphSystem();
    const request = { spec: ProfileNode, args: {} };

    await Effect.runPromise(graph.ensureReadyNode(request));
    const first = await Effect.runPromise(graph.snapshot());

    await Effect.runPromise(graph.ensureNode(request));
    const second = await Effect.runPromise(graph.snapshot());

    expect(second.nodes.map((node) => node.nodeId)).toEqual(first.nodes.map((node) => node.nodeId));
    expect(second.edges).toEqual(first.edges);
    expect(second.nodes.find((node) => node.tag === "resources/profile")?.dependencies).toEqual(
      first.nodes.find((node) => node.tag === "resources/profile")?.dependencies
    );
  });

  test("re-planning the same identity with dependency-changing args invalidates the cell", async () => {
    // Under-capturing key: the parent key projects none of the args, so requests
    // with different args share one graph identity while their static dependency
    // record diverges. Planning must surface the divergence as a structured
    // invariant violation instead of silently mixing old args with new edges.
    type ReplanLeafSpec = NodeSpec<{
      readonly args: { readonly which: string };
      readonly key: Key.Structure<{ readonly which: string }>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReplanLeafNode extends NodeBase<ReplanLeafSpec, "effect"> {
      static readonly spec = serviceSpec.effect<ReplanLeafSpec>({
        tag: "services/replan-leaf",
        key: (args) => Key.structure({ which: args.which }),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("leaf")),
      });
    }

    type ReplanParentSpec = NodeSpec<{
      readonly args: { readonly which: string };
      readonly key: Key.Singleton;
      readonly deps: {
        readonly leaf: Dep<typeof ReplanLeafNode>;
      };
      readonly result: string;
    }>;

    class ReplanParentNode extends NodeBase<ReplanParentSpec, "effect"> {
      static readonly spec = resourceSpec.effect<ReplanParentSpec>({
        tag: "resources/replan-parent",
        key: () => Key.singleton(),
        dependencies: dependencies((args) => ({
          leaf: dep(ReplanLeafNode, { which: args.which }),
        })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.deps.leaf.result)),
      });
    }

    const graph = makeInMemoryGraphSystem();

    const first = await Effect.runPromise(
      graph.ensureNode({ spec: ReplanParentNode, args: { which: "a" } })
    );
    const second = await Effect.runPromise(
      graph.ensureNode({ spec: ReplanParentNode, args: { which: "b" } })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const parentLeafEdges = snapshot.edges.filter(
      (edge) => edge.from === first.nodeId && edge.dependency === "leaf"
    );

    expect(second.nodeId).toBe(first.nodeId);
    expect(second._tag).toBe("Invalid");
    expect(second._tag === "Invalid" ? second.error : undefined).toBeInstanceOf(
      GraphInvariantViolation
    );
    expect(second._tag === "Invalid" ? second.error : undefined).toMatchObject({
      invariant: "same-identity re-plan cannot change static dependencies",
    });
    // One dependency name must map to exactly one edge; the stale edge would
    // otherwise feed reverse adjacency in eviction and over-evict.
    expect(parentLeafEdges).toHaveLength(1);
    expect(snapshot.nodes.filter((node) => node.tag === "services/replan-leaf")).toHaveLength(1);
  });

  test("re-planning invalidates an acquiring cell without wedging the actor", async () => {
    const acquireStarted = await Effect.runPromise(Deferred.make<void>());
    const acquireGate = await Effect.runPromise(Deferred.make<string>());

    type MidAcquireLeafSpec = NodeSpec<{
      readonly args: { readonly which: string };
      readonly key: Key.Structure<{ readonly which: string }>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class MidAcquireLeafNode extends NodeBase<MidAcquireLeafSpec> {
      static readonly spec = serviceSpec.effect<MidAcquireLeafSpec>({
        tag: "services/mid-acquire-replan-leaf",
        key: (args) => Key.structure({ which: args.which }),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("leaf")),
      });
    }

    type MidAcquireParentSpec = NodeSpec<{
      readonly args: { readonly which: string };
      readonly key: Key.Singleton;
      readonly deps: {
        readonly leaf: Dep<typeof MidAcquireLeafNode>;
      };
      readonly result: string;
    }>;

    class MidAcquireParentNode extends NodeBase<MidAcquireParentSpec> {
      static readonly spec = resourceSpec.effect<MidAcquireParentSpec>({
        tag: "resources/mid-acquire-replan-parent",
        key: () => Key.singleton(),
        dependencies: dependencies((args) => ({
          leaf: dep(MidAcquireLeafNode, { which: args.which }),
        })),
        acquire: Driver.Acquire((ctx) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(acquireStarted, undefined);
            const suffix = yield* Deferred.await(acquireGate);
            return `${ctx.deps.leaf.result}:${suffix}`;
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const firstReady = Effect.runPromise(
      graph.ensureReadyNode({ spec: MidAcquireParentNode, args: { which: "a" } })
    );

    await Effect.runPromise(Deferred.await(acquireStarted));
    const invalid = await Effect.runPromise(
      graph.ensureNode({ spec: MidAcquireParentNode, args: { which: "b" } })
    );
    await Effect.runPromise(Deferred.succeed(acquireGate, "late"));
    const first = await firstReady;
    const snapshot = await Effect.runPromise(graph.snapshot());
    const parent = snapshot.nodes.find(
      (node) => node.tag === "resources/mid-acquire-replan-parent"
    );

    expect(invalid._tag).toBe("Invalid");
    expect(first._tag).toBe("Error");
    expect(parent?.status._tag).toBe("Invalid");
    expect(parent?.result).toBeUndefined();
  });

  test("dependency cycles become invalid graph state and do not run drivers", async () => {
    let acquireCount = 0;

    type FirstSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly second: Dep<typeof SecondNode>;
      };
      readonly result: null;
    }>;

    class FirstNode extends NodeBase<FirstSpec, "effect"> {
      static readonly spec = resourceSpec.effect<FirstSpec>({
        tag: "resources/cycle-first",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          second: dep(SecondNode, {}),
        })),
        acquire: Driver.Acquire(() =>
          Effect.sync(() => {
            acquireCount += 1;
            return null;
          })
        ),
      });
    }

    type SecondSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly first: Dep<typeof FirstNode>;
      };
      readonly result: null;
    }>;

    class SecondNode extends NodeBase<SecondSpec, "effect"> {
      static readonly spec = resourceSpec.effect<SecondSpec>({
        tag: "resources/cycle-second",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          first: dep(FirstNode, {}),
        })),
        acquire: Driver.Acquire(() =>
          Effect.sync(() => {
            acquireCount += 1;
            return null;
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: FirstNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const cycleNodes = snapshot.nodes.filter((node) => node.tag.startsWith("resources/cycle-"));

    expect(handle.status._tag).toBe("Invalid");
    expect(cycleNodes).toHaveLength(2);
    expect(cycleNodes.every((node) => node.status._tag === "Invalid")).toBe(true);
    expect(cycleNodes.every((node) => node.failure instanceof CycleDetected)).toBe(true);
    expect(acquireCount).toBe(0);
  });

  test("invalid key values become invalid graph state instead of escaping planning", async () => {
    type InvalidKeySpec = NodeSpec<{
      readonly args: { readonly value: number };
      readonly key: Key.Structure<{ readonly value: number }>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class InvalidKeyNode extends NodeBase<InvalidKeySpec, "effect"> {
      static readonly spec = serviceSpec.effect<InvalidKeySpec>({
        tag: "services/invalid-key",
        key: (args) => Key.structure({ value: args.value }),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureNode({ spec: InvalidKeyNode, args: { value: NaN } })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/invalid-key");

    expect(handle.status._tag).toBe("Invalid");
    expect(node?.failure).toBeInstanceOf(KeyBuildFailed);
    expect(handle.nodeId).toContain("__invalid__");
  });

  test("unsupported object keys become invalid graph state", async () => {
    type InvalidObjectKeySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Structure<{ readonly date: string }>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class InvalidObjectKeyNode extends NodeBase<InvalidObjectKeySpec, "effect"> {
      static readonly spec = serviceSpec.effect<InvalidObjectKeySpec>({
        tag: "services/invalid-object-key",
        key: () => Key.structure({ date: new Date("2026-01-01T00:00:00.000Z") } as never),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureNode({ spec: InvalidObjectKeyNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/invalid-object-key");

    expect(handle.status._tag).toBe("Invalid");
    expect(node?.failure).toBeInstanceOf(KeyBuildFailed);
  });

  test("invalid key identities use typed error tags and paths instead of messages", async () => {
    let firstMessageCounter = 0;
    let secondMessageCounter = 0;

    type ThrowingKeySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FirstThrowingKeyNode extends NodeBase<ThrowingKeySpec> {
      static readonly spec = serviceSpec.effect<ThrowingKeySpec>({
        tag: "services/throwing-key-first",
        key: () => {
          firstMessageCounter += 1;
          throw new Key.KeyNonFiniteNumberError({
            _tag: "KeyNonFiniteNumberError",
            message: `invalid finite value ${firstMessageCounter}`,
            path: "$.id",
            value: Number.NaN,
          });
        },
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }

    class SecondThrowingKeyNode extends NodeBase<ThrowingKeySpec> {
      static readonly spec = serviceSpec.effect<ThrowingKeySpec>({
        tag: "services/throwing-key-second",
        key: () => {
          secondMessageCounter += 1;
          throw new Key.KeyUnsupportedJsonValueError({
            _tag: "KeyUnsupportedJsonValueError",
            message: `invalid JSON value ${secondMessageCounter}`,
            path: "$.id",
          });
        },
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const firstInitial = await Effect.runPromise(
      graph.ensureNode({ spec: FirstThrowingKeyNode, args: {} })
    );
    const firstRepeat = await Effect.runPromise(
      graph.ensureNode({ spec: FirstThrowingKeyNode, args: {} })
    );
    const secondInitial = await Effect.runPromise(
      graph.ensureNode({ spec: SecondThrowingKeyNode, args: {} })
    );
    const secondRepeat = await Effect.runPromise(
      graph.ensureNode({ spec: SecondThrowingKeyNode, args: {} })
    );

    expect(firstInitial.nodeId).toBe(firstRepeat.nodeId);
    expect(secondInitial.nodeId).toBe(secondRepeat.nodeId);
    expect(firstInitial.nodeId).not.toBe(secondInitial.nodeId);
    expect(firstInitial.nodeId).toContain("__invalid__:KeyNonFiniteNumberError:_.id");
    expect(secondInitial.nodeId).toContain("__invalid__:KeyUnsupportedJsonValueError:_.id");
  });

  test("invalid key identities sanitize and cap hostile error paths", async () => {
    const hostileProperty = `line\n${"x".repeat(100_000)}`;
    type HostileKeySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Structure<Record<string, string>>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class HostileKeyNode extends NodeBase<HostileKeySpec> {
      static readonly spec = serviceSpec.effect<HostileKeySpec>({
        tag: "services/hostile-invalid-key",
        key: () => Key.structure({ [hostileProperty]: (() => "invalid") as unknown as string }),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(graph.ensureNode({ spec: HostileKeyNode, args: {} }));
    const label = handle.nodeId.slice("services/hostile-invalid-key:__invalid__:".length);

    expect(handle.nodeId).toContain("__invalid__:KeyUnsupportedJsonValueError:");
    expect(label.length).toBeLessThanOrEqual(180);
    expect(label).toMatch(/^[a-zA-Z0-9_.:-]+$/);
    expect(handle.nodeId).not.toContain("\n");
  });

  test("malformed dependency declarations become invalid graph state", async () => {
    const malformedDependencies = () => "not-a-dependency-record";
    type MalformedDependencySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class MalformedDependencyNode extends NodeBase<MalformedDependencySpec, "effect"> {
      static readonly spec = resourceSpec.effect<MalformedDependencySpec>({
        tag: "resources/malformed-dependencies",
        key: () => Key.singleton(),
        dependencies: dependencies(malformedDependencies as unknown as () => Record<string, never>),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: MalformedDependencyNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/malformed-dependencies");

    expect(handle.status._tag).toBe("Invalid");
    expect(node?.failure).toBeInstanceOf(DependencyDefinitionFailed);
    expect(node?.failure).toMatchObject({
      nodeId: handle.nodeId,
      tag: "resources/malformed-dependencies",
    });
    expect((node?.failure as DependencyDefinitionFailed | undefined)?.cause).toBeInstanceOf(
      GraphInvariantViolation
    );
  });

  test("malformed dependency entries become structured dependency definition failures", async () => {
    type MalformedDependencyEntrySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class MalformedDependencyEntryNode extends NodeBase<MalformedDependencyEntrySpec, "effect"> {
      static readonly spec = resourceSpec.effect<MalformedDependencyEntrySpec>({
        tag: "resources/malformed-dependency-entry",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          malformed: { type: "not-a-dependency", spec: ProfileNode, args: {} } as never,
        })),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: MalformedDependencyEntryNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find(
      (entry) => entry.tag === "resources/malformed-dependency-entry"
    );

    expect(handle.status._tag).toBe("Invalid");
    expect(node?.failure).toBeInstanceOf(DependencyDefinitionFailed);
    expect((node?.failure as DependencyDefinitionFailed | undefined)?.cause).toBeInstanceOf(
      GraphInvariantViolation
    );
    expect((node?.failure as DependencyDefinitionFailed | undefined)?.cause).toMatchObject({
      invariant: "dependency record entry must be a dependency",
      cause: { dependency: "malformed" },
    });
  });

  test("non-canonical dependency args become structured dependency definition failures", async () => {
    type DependencyArgSpec = NodeSpec<{
      readonly args: { readonly id: string };
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class DependencyArgNode extends NodeBase<DependencyArgSpec> {
      static readonly spec = serviceSpec.effect<DependencyArgSpec>({
        tag: "services/non-canonical-dependency-args-child",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("child")),
      });
    }

    type DependencyArgParentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly child: Dep<typeof DependencyArgNode>;
      };
      readonly result: string;
    }>;

    class DependencyArgParentNode extends NodeBase<DependencyArgParentSpec> {
      static readonly spec = resourceSpec.effect<DependencyArgParentSpec>({
        tag: "resources/non-canonical-dependency-args-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          child: dep(DependencyArgNode, {
            id: "child",
            ignoredByKey: () => "not canonical",
          } as { readonly id: string }),
        })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.deps.child.result)),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DependencyArgParentNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const parent = snapshot.nodes.find(
      (entry) => entry.tag === "resources/non-canonical-dependency-args-parent"
    );
    const failure = parent?.failure;

    expect(handle.status._tag).toBe("Invalid");
    expect(failure).toBeInstanceOf(DependencyDefinitionFailed);
    expect((failure as DependencyDefinitionFailed | undefined)?.dependency).toBe("child");
    expect((failure as DependencyDefinitionFailed | undefined)?.cause).toBeInstanceOf(
      Key.KeyUnsupportedJsonValueError
    );
  });

  test("multiple malformed dependency entries aggregate before invalidating parent", async () => {
    class PlainDependency {}
    type MalformedDependencyEntriesSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class MalformedDependencyEntriesNode extends NodeBase<
      MalformedDependencyEntriesSpec,
      "effect"
    > {
      static readonly spec = resourceSpec.effect<MalformedDependencyEntriesSpec>({
        tag: "resources/malformed-dependency-entries",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          first: { type: "not-a-dependency", spec: ProfileNode, args: {} } as never,
          second: { type: "dependency", spec: PlainDependency, args: {} } as never,
        })),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: MalformedDependencyEntriesNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find(
      (entry) => entry.tag === "resources/malformed-dependency-entries"
    );
    const failure = node?.failure;

    expect(handle.status._tag).toBe("Invalid");
    expect(failure).toBeInstanceOf(DependencyDefinitionFailures);

    if (!(failure instanceof DependencyDefinitionFailures)) {
      throw new Error("Expected aggregate dependency definition failure.");
    }

    expect(failure.failures).toHaveLength(2);
    expect(failure.failures.map((entry) => entry.dependency).sort()).toEqual(["first", "second"]);
    expect(failure.failures.every((entry) => entry instanceof DependencyDefinitionFailed)).toBe(
      true
    );
  });

  test("unbranded dependency specs become invalid graph state", async () => {
    class PlainDependency {}
    type UnbrandedDependencySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class UnbrandedDependencyNode extends NodeBase<UnbrandedDependencySpec, "effect"> {
      static readonly spec = resourceSpec.effect<UnbrandedDependencySpec>({
        tag: "resources/unbranded-dependency",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          plain: { type: "dependency", spec: PlainDependency, args: {} },
        })),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: UnbrandedDependencyNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/unbranded-dependency");

    expect(handle.status._tag).toBe("Invalid");
    expect(node?.failure).toBeInstanceOf(DependencyDefinitionFailed);
  });

  test("constructor failures become readiness failures", async () => {
    type ThrowingConstructorSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ThrowingConstructorNode extends NodeBase<ThrowingConstructorSpec, "effect"> {
      static readonly spec = serviceSpec.effect<ThrowingConstructorSpec>({
        tag: "services/throwing-constructor",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
      });

      constructor() {
        super();
        throw new Error("constructor failed");
      }
    }
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ThrowingConstructorNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/throwing-constructor");

    expect(handle.status).toMatchObject({ _tag: "Wired", run: { _tag: "Error" } });
    expect(node?.failure).toBeInstanceOf(AcquireFailed);
    expect((node?.failure as { readonly cause?: unknown } | undefined)?.cause).toBeInstanceOf(
      NodeConstructionFailed
    );
  });

  test("different specs with the same tag are rejected deterministically", async () => {
    type FirstTaggedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FirstTaggedNode extends NodeBase<FirstTaggedSpec, "effect"> {
      static readonly spec = serviceSpec.effect<FirstTaggedSpec>({
        tag: "services/duplicate-tag",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("first")),
      });
    }

    type SecondTaggedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SecondTaggedNode extends NodeBase<SecondTaggedSpec, "effect"> {
      static readonly spec = serviceSpec.effect<SecondTaggedSpec>({
        tag: "services/duplicate-tag",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("second")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureNode({ spec: FirstTaggedNode, args: {} }));
    const handle = await Effect.runPromise(graph.ensureNode({ spec: SecondTaggedNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "services/duplicate-tag");

    expect(handle.status._tag).toBe("Invalid");
    expect(node?.failure).toBeInstanceOf(DuplicateNodeTag);
  });

  test("invalidating a ready node through planning runs driver release and disposers", async () => {
    let releaseRuns = 0;
    let disposerRuns = 0;
    type ReadyInvalidatedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReadyInvalidatedNode extends NodeBase<ReadyInvalidatedSpec, "effect"> {
      static readonly spec = serviceSpec.effect<ReadyInvalidatedSpec>({
        tag: "services/ready-invalidated-teardown",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(() => {
              disposerRuns += 1;
            });
            return "ready";
          })
        ),
        release: Driver.Release(() =>
          Effect.sync(() => {
            releaseRuns += 1;
          })
        ),
      });
    }

    class ConflictingTagNode extends NodeBase<ReadyInvalidatedSpec, "effect"> {
      static readonly spec = serviceSpec.effect<ReadyInvalidatedSpec>({
        tag: "services/ready-invalidated-teardown",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("conflicting")),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ReadyInvalidatedNode, args: {} }));
    const handle = await Effect.runPromise(
      graph.ensureNode({ spec: ConflictingTagNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find(
      (entry) => entry.tag === "services/ready-invalidated-teardown"
    );

    expect(handle.status._tag).toBe("Invalid");
    expect(node?.failure).toBeInstanceOf(DuplicateNodeTag);
    expect(releaseRuns).toBe(1);
    expect(disposerRuns).toBe(1);
  });

  test("ready invalidation release does not block unrelated planning", async () => {
    const releaseStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseGate = await Effect.runPromise(Deferred.make<void>());
    let releaseRuns = 0;
    type SlowInvalidatedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SlowInvalidatedNode extends NodeBase<SlowInvalidatedSpec> {
      static readonly spec = serviceSpec.effect<SlowInvalidatedSpec>({
        tag: "services/slow-invalidated-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
        release: Driver.Release(() =>
          Effect.gen(function* () {
            releaseRuns += 1;
            yield* Deferred.succeed(releaseStarted, undefined);
            yield* Deferred.await(releaseGate);
          })
        ),
      });
    }

    class ConflictingSlowInvalidatedNode extends NodeBase<SlowInvalidatedSpec> {
      static readonly spec = serviceSpec.effect<SlowInvalidatedSpec>({
        tag: "services/slow-invalidated-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("conflicting")),
      });
    }

    type UnrelatedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class UnrelatedNode extends NodeBase<UnrelatedSpec> {
      static readonly spec = serviceSpec.effect<UnrelatedSpec>({
        tag: "services/unrelated-during-invalid-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("unrelated")),
      });
    }

    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: SlowInvalidatedNode, args: {} }));
    const invalidation = Effect.runPromise(
      graph.ensureNode({ spec: ConflictingSlowInvalidatedNode, args: {} })
    );

    await Effect.runPromise(Deferred.await(releaseStarted));

    const unrelated = await Effect.runPromise(
      graph.ensureNode({ spec: UnrelatedNode, args: {} }).pipe(Effect.timeout("50 millis"))
    );

    await Effect.runPromise(Deferred.succeed(releaseGate, undefined));
    const invalid = await invalidation;

    expect(unrelated.status).toMatchObject({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(invalid.status._tag).toBe("Invalid");
    expect(releaseRuns).toBe(1);
  });

  test("spec overrides substitute dependency node specs during planning and readiness", async () => {
    type OriginalServiceSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class OriginalServiceNode extends NodeBase<OriginalServiceSpec, "effect"> {
      static readonly spec = serviceSpec.effect<OriginalServiceSpec>({
        tag: "services/original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("original")),
      });
    }

    class OverrideServiceNode extends OriginalServiceNode {
      static override readonly spec = serviceSpec.effect<OriginalServiceSpec>({
        tag: "services/original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("override")),
      });
    }

    type UsesServiceSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly service: Dep<typeof OriginalServiceNode>;
      };
      readonly result: string;
    }>;

    class UsesServiceNode extends NodeBase<UsesServiceSpec, "effect"> {
      static readonly spec = resourceSpec.effect<UsesServiceSpec>({
        tag: "resources/uses-service-override",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          service: dep(OriginalServiceNode, {}),
        })),
        acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.deps.service.result)),
      });
    }

    const graph = makeInMemoryGraphSystem({
      specOverrides: [{ from: OriginalServiceNode, to: OverrideServiceNode }],
    });
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: UsesServiceNode, args: {} })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const dependency = snapshot.nodes.find((node) => node.tag === "services/original");

    expect(handle.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(dependency?.result).toBe("override");
    expect(dependency?.node).toBeInstanceOf(OverrideServiceNode);
    expect(snapshot.edges).toEqual([
      {
        from: handle.nodeId,
        to: dependency?.nodeId,
        dependency: "service",
      },
    ]);
  });

  test("runtime spec overrides affect direct client handles", async () => {
    type OriginalSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class OriginalNode extends NodeBase<OriginalSpec, "effect"> {
      static readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("original")),
      });
    }

    class OverrideNode extends OriginalNode {
      static override readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("override")),
      });
    }

    const runtime = createRuntime({
      specOverrides: [{ from: OriginalNode, to: OverrideNode }],
    });
    const handle = runtime.client.node<Record<string, never>, string>(OriginalNode, {});

    await handle.ensureReady();

    const snapshot = await runtime.getSnapshot();

    const read = handle.read();

    expect(read._tag).toBe("Ready");
    expect((read as { readonly node: object }).node).toBeInstanceOf(OverrideNode);
    expect(read).toMatchObject({ _tag: "Ready", result: "override" });
    expect(snapshot.graph.nodes.map((node) => node.tag)).toEqual(["services/runtime-original"]);
  });

  test("Effect runtime construction preserves spec overrides", async () => {
    type OriginalSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class OriginalNode extends NodeBase<OriginalSpec, "effect"> {
      static readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/effect-runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("original")),
      });
    }

    class OverrideNode extends OriginalNode {
      static override readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/effect-runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("override")),
      });
    }

    const host = await Effect.runPromise(
      FrondRuntimeEffect({
        specOverrides: [{ from: OriginalNode, to: OverrideNode }],
      })
    );

    await Effect.runPromise(
      host.submit({
        _tag: "GraphEnsureReadyNode",
        request: { spec: OriginalNode, args: {} },
      })
    );

    const snapshot = await Effect.runPromise(host.getSnapshot());

    expect(snapshot.graph.nodes.map((node) => node.tag)).toEqual([
      "services/effect-runtime-original",
    ]);
  });

  test("explicit override class preserves identity while replacing driver behavior", async () => {
    type OriginalSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class OriginalNode extends NodeBase<OriginalSpec, "effect"> {
      static readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/derive-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("original")),
      });

      get label(): string {
        return `label:${this.result}`;
      }
    }

    class DerivedNode extends OriginalNode {
      static override readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/derive-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("derived")),
      });
    }

    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: DerivedNode, args: {} }));
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes[0]?.node as OriginalNode | undefined;

    expect(handle.nodeId).toBe(graph.resolveNodeIdSync({ spec: OriginalNode, args: {} }));
    expect(snapshot.nodes[0]?.tag).toBe("services/derive-original");
    expect(snapshot.nodes[0]?.result).toBe("derived");
    expect(node).toBeInstanceOf(OriginalNode);
    expect(node?.label).toBe("label:derived");
  });

  test("spec validation rejects duplicate originals and tag mismatches", () => {
    type OriginalSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class OriginalNode extends NodeBase<OriginalSpec, "effect"> {
      static readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/override-validation-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("original")),
      });
    }

    class SameTagNode extends OriginalNode {
      static override readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/override-validation-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("same")),
      });
    }

    class DifferentTagNode extends OriginalNode {
      static override readonly spec = serviceSpec.effect<OriginalSpec>({
        tag: "services/override-validation-different",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("different")),
      });
    }

    expect(() =>
      makeInMemoryGraphSystem({
        specOverrides: [{ from: OriginalNode, to: DifferentTagNode }],
      })
    ).toThrow(SpecOverrideFailed);
    expect(() =>
      makeInMemoryGraphSystem({
        specOverrides: [
          { from: OriginalNode, to: SameTagNode },
          { from: OriginalNode, to: SameTagNode },
        ],
      })
    ).toThrow(SpecOverrideFailed);
  });

  test("spec validation rejects cycles at construction", () => {
    type FirstSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FirstNode extends NodeBase<FirstSpec, "effect"> {
      static readonly spec = serviceSpec.effect<FirstSpec>({
        tag: "services/override-cycle",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("first")),
      });
    }

    class SecondNode extends FirstNode {
      static override readonly spec = serviceSpec.effect<FirstSpec>({
        tag: "services/override-cycle",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("second")),
      });
    }

    expect(() =>
      makeInMemoryGraphSystem({
        specOverrides: [
          { from: FirstNode, to: SecondNode },
          { from: SecondNode, to: FirstNode },
        ],
      })
    ).toThrow(SpecOverrideFailed);
  });
});
