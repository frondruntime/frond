import { afterEach, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import { createDeferred } from "@frondruntime/core/testing";

const runtimes: Frond.Runtime.Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop", reason: "compatibility teardown" });
  }
});

function createRuntime() {
  const runtime = Frond.createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  return runtime;
}

type StringSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: string;
}>;

function distinct<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

test("boot calls in one turn and across turns share acquisition and expose ordered read states", async () => {
  const entered = createDeferred<void>();
  const acquired = createDeferred<string>();
  const acquisitions: string[] = [];
  class ProfileNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/boot"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => {
        acquisitions.push("profile");
        entered.resolve();
        return acquired.promise;
      }),
    });

    get greeting() {
      return `Hello ${this.result}`;
    }
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(ProfileNode, Frond.Args.none);
  expect(handle.read()).toMatchObject({ _tag: "Unwired", nodeId: handle.nodeId });
  expect(runtime.readNodeSnapshotSync(handle.nodeId)).toEqual({
    _tag: "Missing",
    nodeId: handle.nodeId,
  });
  expect(() => handle.readReady()).toThrow(Frond.Runtime.FrondNodeNotReady);
  const states = [handle.read()._tag];
  const unsubscribe = handle.subscribe(() => states.push(handle.read()._tag));
  const first = handle.boot();
  const second = handle.boot();
  expect(first._tag).toBe("Pending");
  expect(second._tag).toBe("Pending");
  await entered.promise;
  expect(handle.boot()._tag).toBe("Pending");
  const readiness = handle.ensureReady();
  acquired.resolve("Ada");
  if (first._tag !== "Pending" || second._tag !== "Pending") {
    throw new Error("Expected both boot callers to observe pending readiness.");
  }
  const [firstRead, secondRead, ensuredRead] = await Promise.all([
    first.attempt,
    second.attempt,
    readiness,
  ]);
  for (const read of [firstRead, secondRead, ensuredRead]) {
    expect(read).toMatchObject({ status: { _tag: "Wired", run: { _tag: "Ready" } } });
  }
  expect(handle.boot()).toMatchObject({ _tag: "Ready", result: "Ada", busy: false });
  const node = await handle.ensureReadyNode();
  expect(node).toBe(handle.readReady());
  expect(node.greeting).toBe("Hello Ada");
  expect(runtime.client.__unsafe.readNode(handle.nodeId)).toMatchObject({
    _tag: "Ready",
    result: "Ada",
    node,
  });
  expect(await runtime.readNodeSnapshot(handle.nodeId)).toMatchObject({
    _tag: "Found",
    snapshot: { result: "Ada", node },
  });
  unsubscribe();
  expect(distinct(states)).toEqual(["Unwired", "Pending", "Ready"]);
  expect(acquisitions).toEqual(["profile"]);
});

test("structural keys canonicalize argument order and preserve distinct keyed nodes", async () => {
  type AccountSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: { readonly account: string; readonly region: string };
    readonly key: Frond.Key.Structure<{ readonly account: string; readonly region: string }>;
    readonly result: string;
  }>;
  const acquired: string[] = [];
  class AccountNode extends Frond.NodeBase<AccountSpec> {
    static readonly spec = Frond.serviceSpec.async<AccountSpec>({
      tag: Frond.tag("compat/lifecycle/keys"),
      key: (argumentsValue) => Frond.Key.structure(argumentsValue),
      acquire: Frond.Driver.Acquire(({ args }) => {
        const identity = `${args.account}/${args.region}`;
        acquired.push(identity);
        return identity;
      }),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const first = runtime.client.node(AccountNode, { account: "one", region: "west" });
  const equivalent = runtime.client.node(AccountNode, { region: "west", account: "one" });
  const different = runtime.client.node(AccountNode, { account: "two", region: "west" });
  expect(first.nodeId).toBe(equivalent.nodeId);
  expect(different.nodeId).not.toBe(first.nodeId);
  await first.ensureReady();
  await equivalent.ensureReady();
  await different.ensureReady();
  expect(first.readReady()).toBe(equivalent.readReady());
  expect(equivalent.readReady().args).toEqual({ account: "one", region: "west" });
  expect(different.readReady().result).toBe("two/west");
  expect(acquired).toEqual(["one/west", "two/west"]);
});

test("singleton handles share the first acquired node despite different non-key arguments", async () => {
  type SelectionSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: { readonly selection: string };
    readonly key: Frond.Key.Singleton;
    readonly result: string;
  }>;
  class SelectionNode extends Frond.NodeBase<SelectionSpec> {
    static readonly spec = Frond.serviceSpec.async<SelectionSpec>({
      tag: Frond.tag("compat/lifecycle/singleton"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(({ args }) => args.selection),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const first = runtime.client.node(SelectionNode, { selection: "first" });
  const later = runtime.client.node(SelectionNode, { selection: "later" });
  await first.ensureReady();
  await later.ensureReady();
  expect(first.nodeId).toBe(later.nodeId);
  expect(later.readReady()).toBe(first.readReady());
  expect(later.read()).toMatchObject({ _tag: "Ready", result: "first" });
  expect(later.readReady().args).toEqual({ selection: "first" });
});

function createDependencyChain() {
  const order: string[] = [];
  let generation = 0;
  class ChildNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/chain-child"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => {
        generation += 1;
        order.push(`child:${generation}`);
        return `child:${generation}`;
      }),
      release: Frond.Driver.Release(({ node }) => {
        order.push(`release:${node.result}`);
      }),
    });
  }
  type ParentSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Frond.Args.None;
    readonly key: Frond.Key.Singleton;
    readonly deps: { readonly child: Frond.Dep<typeof ChildNode> };
    readonly result: string;
  }>;
  class ParentNode extends Frond.NodeBase<ParentSpec> {
    static readonly spec = Frond.facadeSpec.async<ParentSpec>({
      tag: Frond.tag("compat/lifecycle/chain-parent"),
      key: () => Frond.Key.singleton(),
      dependencies: Frond.dependencies(() => ({ child: Frond.dep(ChildNode, Frond.Args.none) })),
      acquire: Frond.Driver.Acquire(({ deps }) => {
        order.push(`parent:${deps.child.result}`);
        return `parent:${deps.child.result}`;
      }),
    });
  }
  return { ChildNode, ParentNode, order };
}

test("parent readiness waits for its child and release permits fresh child acquisition", async () => {
  const { ChildNode, ParentNode, order } = createDependencyChain();
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const parent = runtime.client.node(ParentNode, Frond.Args.none);
  const child = runtime.client.node(ChildNode, Frond.Args.none);
  await parent.ensureReady();
  expect(parent.readReady().deps.child).toBe(child.readReady());
  expect(parent.readReady().result).toBe("parent:child:1");
  await parent.releaseResources("reload parent");
  await child.releaseResources("reload child");
  expect(child.read()._tag).toBe("Idle");
  await parent.ensureReady();
  expect(parent.readReady().result).toBe("parent:child:2");
  expect(order).toEqual([
    "child:1",
    "parent:child:1",
    "release:child:1",
    "child:2",
    "parent:child:2",
  ]);
});

test("evicting a child removes its dependent and both can boot with a fresh incarnation", async () => {
  const { ChildNode, ParentNode } = createDependencyChain();
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const parent = runtime.client.node(ParentNode, Frond.Args.none);
  const child = runtime.client.node(ChildNode, Frond.Args.none);
  await parent.ensureReady();
  const previousParent = parent.readReady();
  const previousChild = child.readReady();
  const eviction = await child.evict("selfAndDependents", "replace dependency");
  expect(new Set(eviction.nodeIds)).toEqual(new Set([child.nodeId, parent.nodeId]));
  expect(eviction.failures).toEqual([]);
  expect(parent.read()._tag).toBe("Unwired");
  expect(child.read()._tag).toBe("Unwired");
  const pending = parent.boot();
  if (pending._tag !== "Pending") throw new Error("Expected a fresh boot attempt.");
  await pending.attempt;
  expect(parent.readReady().result).toBe("parent:child:2");
  expect(parent.readReady()).not.toBe(previousParent);
  expect(child.readReady()).not.toBe(previousChild);
});

test("three-level diamond readiness shares the leaf before either branch and the root", async () => {
  const order: string[] = [];
  const leafEntered = createDeferred<void>();
  const leafResult = createDeferred<string>();
  class LeafNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.serviceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/diamond-leaf"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(async () => {
        leafEntered.resolve();
        const result = await leafResult.promise;
        order.push("leaf");
        return result;
      }),
    });
  }
  type BranchSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: { readonly side: string };
    readonly key: Frond.Key.Structure<{ readonly side: string }>;
    readonly deps: { readonly leaf: Frond.Dep<typeof LeafNode> };
    readonly result: string;
  }>;
  class BranchNode extends Frond.NodeBase<BranchSpec> {
    static readonly spec = Frond.facadeSpec.async<BranchSpec>({
      tag: Frond.tag("compat/lifecycle/diamond-branch"),
      key: (args) => Frond.Key.structure(args),
      dependencies: Frond.dependencies(() => ({ leaf: Frond.dep(LeafNode, Frond.Args.none) })),
      acquire: Frond.Driver.Acquire(({ deps, args }) => {
        order.push(args.side);
        return `${args.side}:${deps.leaf.result}`;
      }),
    });
  }
  type RootSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Frond.Args.None;
    readonly key: Frond.Key.Singleton;
    readonly deps: {
      readonly left: Frond.Dep<typeof BranchNode>;
      readonly right: Frond.Dep<typeof BranchNode>;
    };
    readonly result: string;
  }>;
  class RootNode extends Frond.NodeBase<RootSpec> {
    static readonly spec = Frond.facadeSpec.async<RootSpec>({
      tag: Frond.tag("compat/lifecycle/diamond-root"),
      key: () => Frond.Key.singleton(),
      dependencies: Frond.dependencies(() => ({
        left: Frond.dep(BranchNode, { side: "left" }),
        right: Frond.dep(BranchNode, { side: "right" }),
      })),
      acquire: Frond.Driver.Acquire(({ deps }) => {
        order.push("root");
        return `${deps.left.result}+${deps.right.result}`;
      }),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const root = runtime.client.node(RootNode, Frond.Args.none);
  const readiness = root.ensureReady();
  await leafEntered.promise;
  expect(root.read()._tag).toBe("Pending");
  expect(order).toEqual([]);
  leafResult.resolve("shared");
  await readiness;
  const node = root.readReady();
  expect(node.result).toBe("left:shared+right:shared");
  expect(node.deps.left.deps.leaf).toBe(node.deps.right.deps.leaf);
  expect(order[0]).toBe("leaf");
  expect(new Set(order.slice(1, -1))).toEqual(new Set(["left", "right"]));
  expect(order.at(-1)).toBe("root");
});

test("runtime events preserve semantic order for boot refresh action and eviction", async () => {
  type EventSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Frond.Args.None;
    readonly key: Frond.Key.Singleton;
    readonly result: string;
    readonly actions: { readonly rename: Frond.ActionContract<string, string> };
  }>;
  class EventNode extends Frond.NodeBase<EventSpec> {
    static readonly spec = Frond.resourceSpec.async<EventSpec>({
      tag: Frond.tag("compat/lifecycle/events"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => "initial"),
      refresh: Frond.Driver.Refresh((context) => {
        context.setResult("fresh");
      }),
      actions: {
        rename: Frond.Driver.Action((context, name) => {
          if (name === "reject") throw new Error("rename rejected");
          context.setResult(name);
          return name;
        }),
      },
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(EventNode, Frond.Args.none);
  const eventTags: string[] = [];
  const semanticTags = new Set([
    "GraphNodeReadyEnsured",
    "GraphRefreshStarted",
    "GraphRefreshSucceeded",
    "GraphActionStarted",
    "GraphActionSucceeded",
    "GraphActionFailed",
    "GraphNodesEvicted",
  ]);
  const subscription = runtime.observe((record) => {
    if (record.nodeIds.includes(handle.nodeId) && semanticTags.has(record.event._tag)) {
      eventTags.push(record.event._tag);
    }
  });
  const boot = handle.boot();
  if (boot._tag !== "Pending") throw new Error("Expected initial pending boot.");
  await boot.attempt;
  await handle.refresh();
  expect(handle.readReady().result).toBe("fresh");
  await handle.actions.rename("renamed");
  expect(handle.readReady().result).toBe("renamed");
  expect(await handle.actions.rename("reject")).toMatchObject({
    _tag: "Failure",
    error: { _tag: "ActionFailed", action: "rename", input: "reject" },
  });
  expect(handle.readReady().result).toBe("renamed");
  await handle.evict();
  subscription.unsubscribe();
  expect(distinct(eventTags)).toEqual([
    "GraphNodeReadyEnsured",
    "GraphRefreshStarted",
    "GraphRefreshSucceeded",
    "GraphActionStarted",
    "GraphActionSucceeded",
    "GraphActionStarted",
    "GraphActionFailed",
    "GraphNodesEvicted",
  ]);
});
