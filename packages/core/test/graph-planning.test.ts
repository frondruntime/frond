import { describe, expect, test } from "bun:test";
import {
  AcquireFailed,
  CycleDetected,
  createRuntime,
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

    class ConstructedOnceNode extends NodeBase<ConstructedOnceSpec> {
      static readonly spec = serviceSpec<ConstructedOnceSpec>({
        tag: "services/constructed-once",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ConstructedOnceSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

    class ReplanLeafNode extends NodeBase<ReplanLeafSpec> {
      static readonly spec = serviceSpec<ReplanLeafSpec>({
        tag: "services/replan-leaf",
        key: (args) => Key.structure({ which: args.which }),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReplanLeafSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("leaf")),
        }),
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

    class ReplanParentNode extends NodeBase<ReplanParentSpec> {
      static readonly spec = resourceSpec<ReplanParentSpec>({
        tag: "resources/replan-parent",
        key: () => Key.singleton(),
        dependencies: dependencies((args) => ({
          leaf: dep(ReplanLeafNode, { which: args.which }),
        })),
        driver: Driver.Effect<ReplanParentSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.deps.leaf.result)),
        }),
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

    class FirstNode extends NodeBase<FirstSpec> {
      static readonly spec = resourceSpec<FirstSpec>({
        tag: "resources/cycle-first",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          second: dep(SecondNode, {}),
        })),
        driver: Driver.Effect<FirstSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquireCount += 1;
              return null;
            })
          ),
        }),
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

    class SecondNode extends NodeBase<SecondSpec> {
      static readonly spec = resourceSpec<SecondSpec>({
        tag: "resources/cycle-second",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          first: dep(FirstNode, {}),
        })),
        driver: Driver.Effect<SecondSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquireCount += 1;
              return null;
            })
          ),
        }),
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

    class InvalidKeyNode extends NodeBase<InvalidKeySpec> {
      static readonly spec = serviceSpec<InvalidKeySpec>({
        tag: "services/invalid-key",
        key: (args) => Key.structure({ value: args.value }),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<InvalidKeySpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

    class InvalidObjectKeyNode extends NodeBase<InvalidObjectKeySpec> {
      static readonly spec = serviceSpec<InvalidObjectKeySpec>({
        tag: "services/invalid-object-key",
        key: () => Key.structure({ date: new Date("2026-01-01T00:00:00.000Z") } as never),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<InvalidObjectKeySpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

  test("malformed dependency declarations become invalid graph state", async () => {
    const malformedDependencies = () => "not-a-dependency-record";
    type MalformedDependencySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class MalformedDependencyNode extends NodeBase<MalformedDependencySpec> {
      static readonly spec = resourceSpec<MalformedDependencySpec>({
        tag: "resources/malformed-dependencies",
        key: () => Key.singleton(),
        dependencies: dependencies(malformedDependencies as unknown as () => Record<string, never>),
        driver: Driver.Effect<MalformedDependencySpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

    class MalformedDependencyEntryNode extends NodeBase<MalformedDependencyEntrySpec> {
      static readonly spec = resourceSpec<MalformedDependencyEntrySpec>({
        tag: "resources/malformed-dependency-entry",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          malformed: { type: "not-a-dependency", spec: ProfileNode, args: {} } as never,
        })),
        driver: Driver.Effect<MalformedDependencyEntrySpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

  test("multiple malformed dependency entries aggregate before invalidating parent", async () => {
    class PlainDependency {}
    type MalformedDependencyEntriesSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class MalformedDependencyEntriesNode extends NodeBase<MalformedDependencyEntriesSpec> {
      static readonly spec = resourceSpec<MalformedDependencyEntriesSpec>({
        tag: "resources/malformed-dependency-entries",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          first: { type: "not-a-dependency", spec: ProfileNode, args: {} } as never,
          second: { type: "dependency", spec: PlainDependency, args: {} } as never,
        })),
        driver: Driver.Effect<MalformedDependencyEntriesSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

    class UnbrandedDependencyNode extends NodeBase<UnbrandedDependencySpec> {
      static readonly spec = resourceSpec<UnbrandedDependencySpec>({
        tag: "resources/unbranded-dependency",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          plain: { type: "dependency", spec: PlainDependency, args: {} },
        })),
        driver: Driver.Effect<UnbrandedDependencySpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

    class ThrowingConstructorNode extends NodeBase<ThrowingConstructorSpec> {
      static readonly spec = serviceSpec<ThrowingConstructorSpec>({
        tag: "services/throwing-constructor",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ThrowingConstructorSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
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

    class FirstTaggedNode extends NodeBase<FirstTaggedSpec> {
      static readonly spec = serviceSpec<FirstTaggedSpec>({
        tag: "services/duplicate-tag",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FirstTaggedSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("first")),
        }),
      });
    }

    type SecondTaggedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SecondTaggedNode extends NodeBase<SecondTaggedSpec> {
      static readonly spec = serviceSpec<SecondTaggedSpec>({
        tag: "services/duplicate-tag",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SecondTaggedSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("second")),
        }),
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

    class ReadyInvalidatedNode extends NodeBase<ReadyInvalidatedSpec> {
      static readonly spec = serviceSpec<ReadyInvalidatedSpec>({
        tag: "services/ready-invalidated-teardown",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReadyInvalidatedSpec>({
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
        }),
      });
    }

    class ConflictingTagNode extends NodeBase<ReadyInvalidatedSpec> {
      static readonly spec = serviceSpec<ReadyInvalidatedSpec>({
        tag: "services/ready-invalidated-teardown",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReadyInvalidatedSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("conflicting")),
        }),
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

  test("spec overrides substitute dependency node specs during planning and readiness", async () => {
    type OriginalServiceSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class OriginalServiceNode extends NodeBase<OriginalServiceSpec> {
      static readonly spec = serviceSpec<OriginalServiceSpec>({
        tag: "services/original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalServiceSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("original")),
        }),
      });
    }

    class OverrideServiceNode extends OriginalServiceNode {
      static override readonly spec = serviceSpec<OriginalServiceSpec>({
        tag: "services/original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalServiceSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("override")),
        }),
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

    class UsesServiceNode extends NodeBase<UsesServiceSpec> {
      static readonly spec = resourceSpec<UsesServiceSpec>({
        tag: "resources/uses-service-override",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          service: dep(OriginalServiceNode, {}),
        })),
        driver: Driver.Effect<UsesServiceSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.deps.service.result)),
        }),
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

    class OriginalNode extends NodeBase<OriginalSpec> {
      static readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("original")),
        }),
      });
    }

    class OverrideNode extends OriginalNode {
      static override readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("override")),
        }),
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

    class OriginalNode extends NodeBase<OriginalSpec> {
      static readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/effect-runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("original")),
        }),
      });
    }

    class OverrideNode extends OriginalNode {
      static override readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/effect-runtime-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("override")),
        }),
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

    class OriginalNode extends NodeBase<OriginalSpec> {
      static readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/derive-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("original")),
        }),
      });

      get label(): string {
        return `label:${this.result}`;
      }
    }

    class DerivedNode extends OriginalNode {
      static override readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/derive-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("derived")),
        }),
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

    class OriginalNode extends NodeBase<OriginalSpec> {
      static readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/override-validation-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("original")),
        }),
      });
    }

    class SameTagNode extends OriginalNode {
      static override readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/override-validation-original",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("same")),
        }),
      });
    }

    class DifferentTagNode extends OriginalNode {
      static override readonly spec = serviceSpec<OriginalSpec>({
        tag: "services/override-validation-different",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OriginalSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("different")),
        }),
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

    class FirstNode extends NodeBase<FirstSpec> {
      static readonly spec = serviceSpec<FirstSpec>({
        tag: "services/override-cycle",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FirstSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("first")),
        }),
      });
    }

    class SecondNode extends FirstNode {
      static override readonly spec = serviceSpec<FirstSpec>({
        tag: "services/override-cycle",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FirstSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("second")),
        }),
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
