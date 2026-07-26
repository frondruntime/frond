import { Context, Effect } from "effect";
import type {
  ActionContract,
  ActiveNodeLiveDemandSnapshot,
  AsyncAcquireDriverContext,
  AsyncDriverContext,
  AsyncLiveContext,
  Dep,
  DriverContext,
  LiveResourceStopReason,
  NodeSpecArgs,
  NodeSpecInstance,
  NodeSpecResolvedDeps,
} from "../../src";
import {
  Args,
  Driver,
  dep,
  dependencies,
  facadeSpec,
  Key,
  NodeBase,
  nodeSpec,
  resourceSpec,
  serviceSpec,
  tag,
  unwrapEffect,
} from "../../src";
import type { GraphNodeCellView, GraphNodeState } from "../../src/graph/cell/cellModel";
import { createFrondTestHarness, mockSpec, readySpec } from "../../src/testing";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

type TransportSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: TransportResult;
}>;

// @ts-expect-error node spec args must be canonical JSON-shaped key inputs
export type FunctionArgsSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly onSelect: () => void };
  readonly key: Key.Singleton;
  readonly result: string;
}>;

// @ts-expect-error node spec args must reject Date instances
export type DateArgsSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly at: Date };
  readonly key: Key.Singleton;
  readonly result: string;
}>;

declare class NonJsonArgsValue {
  readonly id: string;
}

// @ts-expect-error node spec args must reject class instances
export type ClassInstanceArgsSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly value: NonJsonArgsValue };
  readonly key: Key.Singleton;
  readonly result: string;
}>;

// @ts-expect-error every node spec shape must declare its driver mode
export type ModelessSpec = import("../../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: string;
}>;

export type ArgsNoneIsCanonical = Expect<
  Args.None extends import("../../src").Key.KeyInput ? true : false
>;

type TransportResult = {
  readonly token: string;
};

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec.async<TransportSpec>({
    tag: tag("types/transport"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire((): TransportResult => ({ token: "token" })),
  });

  get bearer(): string {
    return `Bearer ${this.result.token}`;
  }
}

const DriverValue = Context.Service<{ readonly value: string }>("types/node-authoring/DriverValue");

type ServiceBackedSpec = import("../../src").NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: string;
}>;

class RChannelRejectedNode extends NodeBase<ServiceBackedSpec> {
  static readonly spec = serviceSpec.effect<ServiceBackedSpec>({
    tag: tag("types/r-channel-rejected"),
    key: () => Key.singleton(),
    // The requirements parameter is deleted from the effect factories and the
    // channel stays pinned to never: the runtime provisions no services, so a
    // service-requiring hook must not typecheck.
    // @ts-expect-error acquire Effects must not require services
    acquire: Driver.Acquire(() =>
      Effect.gen(function* () {
        const service = yield* DriverValue;
        return service.value;
      })
    ),
  });
}

// Usage marker: the class exists to host the @ts-expect-error pin above.
void RChannelRejectedNode.spec;

type CounterSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly count: number };
  readonly actions: {
    readonly bump: ActionContract<{ readonly by: number }, { readonly count: number }>;
  };
}>;

class CounterNode extends NodeBase<CounterSpec> {
  static readonly spec = serviceSpec.async<CounterSpec>({
    tag: tag("types/counter"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => ({ count: 1 })),
    actions: {
      bump: Driver.Action(
        (
          _ctx: AsyncDriverContext<
            NodeBase<CounterSpec>,
            NodeSpecArgs<CounterSpec>,
            NodeSpecResolvedDeps<CounterSpec>,
            { readonly count: number }
          >,
          input: { readonly by: number }
        ) => ({ count: input.by })
      ),
    },
  });

  get count(): number {
    return this.result.count;
  }

  bump(by: number): Promise<{ readonly count: number }> {
    return this.actions.bump({ by });
  }
}

type ProfileArgs = {
  readonly id: string;
};

type ProfileResult = {
  readonly name: string;
};

type ProfileDeps = {
  readonly transport: Dep<typeof TransportNode>;
};

type ProfileActions = {
  readonly rename: ActionContract<{ readonly name: string }, { readonly ok: true }>;
};

type ProfileSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: ProfileArgs;
  readonly key: Key.Structure<{ readonly id: string }>;
  readonly deps: ProfileDeps;
  readonly result: ProfileResult;
  readonly actions: ProfileActions;
}>;

type ProfileAcquireContext = AsyncAcquireDriverContext<
  ProfileArgs,
  NodeSpecResolvedDeps<ProfileSpec>,
  ProfileResult
>;

type ProfileNodeContext = AsyncDriverContext<
  NodeBase<ProfileSpec>,
  ProfileArgs,
  NodeSpecResolvedDeps<ProfileSpec>,
  ProfileResult
>;

const profileActions = {
  rename: Driver.Action((_ctx: ProfileNodeContext, input: { readonly name: string }) => {
    _ctx.node.result satisfies ProfileResult;
    _ctx.refreshDep("transport") satisfies Promise<NodeSpecInstance<typeof TransportNode>>;
    // @ts-expect-error driver dependency refresh is limited to declared dependency names
    _ctx.refreshDep("missing");
    input.name satisfies string;
    return { ok: true as const };
  }),
};

class ProfileNode extends NodeBase<ProfileSpec> {
  static readonly spec = resourceSpec.async<ProfileSpec, typeof profileActions>({
    tag: tag("types/profile"),
    key: (args) => Key.structure({ id: args.id }),
    dependencies: dependencies((args: ProfileArgs) => {
      args.id satisfies string;
      return {
        transport: dep(TransportNode, Args.none),
      };
    }),
    acquire: Driver.Acquire((ctx: ProfileAcquireContext): Promise<ProfileResult> => {
      ctx.args.id satisfies string;
      ctx.deps.transport.bearer satisfies string;
      // @ts-expect-error acquire runs before the ready author node exists
      ctx.node;
      // @ts-expect-error acquire does not schedule dependency refresh
      ctx.refreshDep;
      ctx.setResult({ name: "Ada" });
      return Promise.resolve({ name: "Ada" });
    }),
    refresh: Driver.Refresh(async (ctx) => {
      const transport = await ctx.refreshDep("transport");
      transport.bearer satisfies string;
    }),
    actions: profileActions,
  });

  rename(name: string): Promise<{ readonly ok: true }> {
    return this.actions.rename({ name });
  }

  invalidDirectResultMutation(): void {
    // @ts-expect-error node result writes must go through graph-owned driver/update paths
    this.result = { name: "invalid" };
  }
}

const harness = createFrondTestHarness();
const counter = await harness.startNode(CounterNode, Args.none);
counter.count satisfies number;
// Async node: the action facade is Promise-native.
counter.actions.bump({ by: 2 }) satisfies Promise<{ readonly count: number }>;
counter.bump(2) satisfies Promise<{ readonly count: number }>;
// @ts-expect-error generated action input is checked
counter.actions.bump({ by: "wrong" });
// @ts-expect-error generated actions do not accept missing input for input-bearing actions
counter.actions.bump();

const handle = harness.node(ProfileNode, { id: "profile-3" });
type HandleArgsCheck = Expect<Equal<typeof handle.args, ProfileArgs>>;
const handleArgsCheck: HandleArgsCheck = true;
handleArgsCheck satisfies true;
// The untyped handle primitive is an Effect; bridge to a Promise with unwrapEffect.
unwrapEffect(handle.action("rename", { name: "Ada" })) satisfies Promise<unknown>;
handle.action("rename", { name: "Ada" }) satisfies Effect.Effect<unknown, unknown>;
// Monotonic revision for external-store getSnapshot stability.
handle.readVersion() satisfies number;
// The typed read surface: Ready.result is exactly the declared result type
// (never `| undefined`), and Ready.node is the nominal class instance — no
// `as ProfileNode` cast at the consumer.
{
  const profileHandleRead = handle.read();
  if (profileHandleRead._tag === "Ready") {
    type ReadyResultIsExact = Expect<Equal<typeof profileHandleRead.result, ProfileResult>>;
    const readyResultIsExact: ReadyResultIsExact = true;
    readyResultIsExact satisfies true;
    profileHandleRead.result.name satisfies string;
    profileHandleRead.node satisfies ProfileNode;
    const readNodeAsClass: ProfileNode = profileHandleRead.node;
    readNodeAsClass.rename("Ada") satisfies Promise<{ readonly ok: true }>;
  }

  // The typed snapshot lookup carries the same node/result typing.
  const profileSnapshotLookup = await handle.snapshot();
  if (profileSnapshotLookup._tag === "Found" && profileSnapshotLookup.snapshot._tag === "Ready") {
    profileSnapshotLookup.snapshot.result satisfies ProfileResult;
    profileSnapshotLookup.snapshot.node satisfies ProfileNode;
  }
}
const started = await harness.startNode(ProfileNode, { id: "profile-4" });
started.rename("Dorothy") satisfies Promise<{ readonly ok: true }>;

const mocked = mockSpec(ProfileNode, {
  driver: resourceSpec.async<ProfileSpec, typeof profileActions>({
    tag: tag("types/profile-mock"),
    key: (args) => Key.structure({ id: args.id }),
    acquire: Driver.Acquire((): ProfileResult => ({ name: "Mocked" })),
    actions: profileActions,
  }).driver,
});
const ready = readySpec(ProfileNode, { name: "Ready" });
harness.node(mocked, { id: "mocked" });
harness.node(ready, { id: "ready" });

// @ts-expect-error dependency args are checked against dependency spec args
dep(TransportNode, { id: "wrong" });

const wrongReturnProfileActions = {
  rename: Driver.Action((_ctx: ProfileNodeContext, _input: { readonly name: string }) => ({
    ok: false as const,
  })),
};

// @ts-expect-error out-of-line action maps are checked against the declared action contracts
resourceSpec.async<ProfileSpec, typeof wrongReturnProfileActions>({
  tag: tag("types/profile-wrong-return"),
  key: (args) => Key.structure({ id: args.id }),
  acquire: Driver.Acquire((): ProfileResult => ({ name: "Ada" })),
  actions: wrongReturnProfileActions,
});

const phantomProfileActions = {
  ...profileActions,
  phantom: Driver.Action((_ctx: ProfileNodeContext) => ({ ok: true as const })),
};

resourceSpec.async<ProfileSpec, typeof phantomProfileActions>({
  tag: tag("types/profile-phantom-action"),
  key: (args) => Key.structure({ id: args.id }),
  acquire: Driver.Acquire((): ProfileResult => ({ name: "Ada" })),
  // @ts-expect-error undeclared action keys never register in the driver registry
  actions: phantomProfileActions,
});

// --- action admission contracts --------------------------------------------

type SessionSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly session: string };
  readonly actions: {
    readonly expire: ActionContract<void, string>;
  };
}>;

type SessionActionContext = AsyncDriverContext<
  NodeBase<SessionSpec>,
  NodeSpecArgs<SessionSpec>,
  NodeSpecResolvedDeps<SessionSpec>,
  { readonly session: string }
>;

// Void-input actions may declare join admission with no admissionKey: the
// runtime joins concurrent invocations on a constant per-node/action key.
serviceSpec.async<SessionSpec>({
  tag: tag("types/session-void-join"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => ({ session: "s" })),
  actions: {
    expire: Driver.Action((_ctx: SessionActionContext) => "expired", {
      admission: "join",
    }),
  },
});

// The void-input join surface is strict: there is no input to derive a key
// from, so an explicit admissionKey is rejected instead of silently ignored.
Driver.Action<SessionActionContext, void, string>((_ctx) => "expired", {
  admission: "join",
  // @ts-expect-error void-input join admission does not accept admissionKey
  admissionKey: () => "constant",
});

// Input-bearing actions still require admissionKey for join admission.
Driver.Action(
  (_ctx: ProfileNodeContext, _input: { readonly name: string }) => ({ ok: true as const }),
  // @ts-expect-error join admission on input-bearing actions requires admissionKey(input)
  { admission: "join" }
);

Driver.Action(
  (_ctx: ProfileNodeContext, input: { readonly name: string }) => ({ ok: true as const, input }),
  {
    admission: "join",
    admissionKey: (input) => input.name,
  }
);

type EffectSpec = import("../../src").NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly ok: true };
  readonly actions: {
    readonly ping: ActionContract<{ readonly message: string }, number>;
  };
}>;

// The same shape members as ProfileSpec, flavored effect: one spec type can no
// longer serve both factory flavors because the mode is part of the shape.
type EffectProfileSpec = import("../../src").NodeSpec<{
  readonly mode: "effect";
  readonly args: ProfileArgs;
  readonly key: Key.Structure<{ readonly id: string }>;
  readonly deps: ProfileDeps;
  readonly result: ProfileResult;
  readonly actions: ProfileActions;
}>;

type EffectProfileContext = DriverContext<
  NodeBase<EffectProfileSpec>,
  ProfileArgs,
  NodeSpecResolvedDeps<EffectProfileSpec>,
  ProfileResult
>;

resourceSpec.effect<EffectProfileSpec>({
  tag: tag("types/profile-effect-refresh"),
  key: (args) => Key.structure({ id: args.id }),
  dependencies: dependencies(() => ({
    transport: dep(TransportNode, Args.none),
  })),
  acquire: Driver.Acquire(() => Effect.succeed({ name: "Ada" })),
  refresh: Driver.Refresh((ctx: EffectProfileContext) =>
    Effect.gen(function* () {
      const transport = yield* ctx.refreshDep("transport");
      transport.bearer satisfies string;
      // @ts-expect-error effect driver dependency refresh is limited to declared dependency names
      yield* ctx.refreshDep("missing");
    })
  ),
});

class EffectNode extends NodeBase<EffectSpec> {
  static readonly spec = serviceSpec.effect<EffectSpec>({
    tag: tag("types/effect"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => Effect.succeed({ ok: true as const })),
    actions: {
      ping: Driver.Action((_ctx, input: { readonly message: string }) =>
        Effect.succeed(input.message.length)
      ),
    },
  });

  // In-class actions derive the Effect representation from the shape-declared
  // mode with no second NodeBase type argument.
  ping(message: string): Effect.Effect<number, unknown> {
    return this.actions.ping({ message });
  }
}

// The shape-declared mode is the authored mode the spec reports.
type EffectNodeMode = Expect<Equal<import("../../src").NodeSpecMode<typeof EffectNode>, "effect">>;
const effectNodeMode: EffectNodeMode = true;
effectNodeMode satisfies true;

// @ts-expect-error NodeBase takes no mode argument; the spec shape declares it
export class ModeArgumentRejectedNode extends NodeBase<EffectSpec, "effect"> {}

const effectStarted = await harness.startNode(EffectNode, Args.none);
// Effect node: the action facade is Effect-native; unwrapEffect bridges to a Promise.
unwrapEffect(effectStarted.actions.ping({ message: "effect" })) satisfies Promise<number>;
effectStarted.actions.ping({ message: "effect" }) satisfies Effect.Effect<number, unknown>;
// @ts-expect-error inferred effect action input is checked
effectStarted.actions.ping({ message: 1 });

// Nominal identity: a class that declares its authored mode keeps its own type
// through NodeSpecInstance, so dep-injected instances stay assignable to the
// class and instanceof narrowing still works.
type EffectInstanceIdentity = Expect<Equal<NodeSpecInstance<typeof EffectNode>, EffectNode>>;
const effectInstanceIdentity: EffectInstanceIdentity = true;
effectInstanceIdentity satisfies true;
declare const effectInstance: NodeSpecInstance<typeof EffectNode>;
const effectInstanceAsClass: EffectNode = effectInstance;
effectInstanceAsClass satisfies EffectNode;
effectInstance.actions.ping({ message: "effect" }) satisfies Effect.Effect<number, unknown>;

// Same identity for an async node, whose shape declares mode: "async".
type ProfileInstanceIdentity = Expect<Equal<NodeSpecInstance<typeof ProfileNode>, ProfileNode>>;
const profileInstanceIdentity: ProfileInstanceIdentity = true;
profileInstanceIdentity satisfies true;
type ProfileNodeMode = Expect<Equal<import("../../src").NodeSpecMode<typeof ProfileNode>, "async">>;
const profileNodeMode: ProfileNodeMode = true;
profileNodeMode satisfies true;
declare const profileInstance: NodeSpecInstance<typeof ProfileNode>;
const profileInstanceAsClass: ProfileNode = profileInstance;
profileInstanceAsClass satisfies ProfileNode;
profileInstance.actions.rename({ name: "Ada" }) satisfies Promise<{ readonly ok: true }>;

// A hand-written class that merely carries a spec is not a node: only the
// `NodeBase` constructor wires the runtime action facade, so
// `NodeSpecInstance` must not fabricate a typed `actions` surface that never
// exists at runtime.
class HandwrittenSpecCarrier {
  static readonly spec = EffectNode.spec;
  readonly handwritten = true;
}

declare const handwrittenInstance: NodeSpecInstance<typeof HandwrittenSpecCarrier>;
handwrittenInstance.handwritten satisfies boolean;
// @ts-expect-error non-NodeBase spec carriers get no fabricated action facade
handwrittenInstance.actions;

serviceSpec.effect<EffectSpec>({
  tag: tag("types/effect-node-actions"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => Effect.succeed({ ok: true as const })),
  actions: {
    ping: Driver.Action((ctx, input: { readonly message: string }) => {
      // Effect-mode hooks see the effect-native node: the action facade hands
      // back Effects, not Promises.
      ctx.node.actions.ping({ message: input.message }) satisfies Effect.Effect<number, unknown>;
      return Effect.succeed(input.message.length);
    }),
  },
});

serviceSpec.async<CounterSpec>({
  tag: tag("types/counter-async-guard"),
  key: () => Key.singleton(),
  // @ts-expect-error async drivers must not return Effect values
  acquire: Driver.Acquire(() => Effect.succeed("not async authoring")),
});

type EffectCounterSpec = import("../../src").NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly count: number };
}>;

serviceSpec.effect<EffectCounterSpec>({
  tag: tag("types/counter-effect-guard"),
  key: () => Key.singleton(),
  // @ts-expect-error effect drivers must return Effect values
  acquire: Driver.Acquire(() => "not effect authoring"),
});

// --- mode-in-spec-shape contracts ------------------------------------------

// The historical footgun: an effect-authored node whose spec shape forgot the
// mode. `.effect` rejects the spec at the type argument, so a class can never
// end up with a Promise-typed `this.actions` over an Effect-returning runtime.
// @ts-expect-error a spec shape without mode: "effect" is rejected by .effect
serviceSpec.effect<ModelessSpec>({
  tag: tag("types/modeless-shape-effect-factory"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => Effect.succeed("ready")),
});

// The reverse mismatch: an effect-mode shape handed to the async factory.
// @ts-expect-error a spec shape with mode: "effect" is rejected by .async
serviceSpec.async<EffectCounterSpec>({
  tag: tag("types/counter-effect-shape-async-factory"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => ({ count: 1 })),
});

// Driver.Async / Driver.Effect are public again and carry the same shape-mode
// constraint as the factories.
const asyncCounterDriver = Driver.Async<CounterSpec>({
  acquire: Driver.Acquire(() => ({ count: 1 })),
});
const effectCounterDriver = Driver.Effect<EffectCounterSpec>({
  acquire: Driver.Acquire(() => Effect.succeed({ count: 1 })),
});

// @ts-expect-error Driver.Effect requires a spec shape declaring mode: "effect"
Driver.Effect<CounterSpec>({
  acquire: Driver.Acquire(() => Effect.succeed({ count: 1 })),
});

// @ts-expect-error Driver.Async requires a spec shape declaring mode: "async"
Driver.Async<EffectCounterSpec>({
  acquire: Driver.Acquire(() => ({ count: 1 })),
});

// fromDriver accepts a pre-built driver whose mode literal agrees with the
// shape-declared mode...
nodeSpec.fromDriver<EffectCounterSpec>({
  tag: tag("types/counter-from-driver"),
  key: () => Key.singleton(),
  driver: effectCounterDriver,
});

// ...and rejects one whose mode disagrees.
nodeSpec.fromDriver<EffectCounterSpec>({
  tag: tag("types/counter-from-driver-mismatch"),
  key: () => Key.singleton(),
  // @ts-expect-error fromDriver rejects a driver whose mode disagrees with the shape mode
  driver: asyncCounterDriver,
});

// The one-declaration mode contract holds at the escape hatch too: a shape
// whose mode is still the full `"async" | "effect"` union is rejected for
// BOTH driver flavors — narrow the shape's mode before wiring a driver.
type UnionModeCounterSpec = import("../../src").NodeSpec<{
  readonly mode: "async" | "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly count: number };
}>;

const asyncPlainCounterDriver = Driver.Async<
  import("../../src").NodeSpec<{
    readonly mode: "async";
    readonly args: Args.None;
    readonly key: Key.Singleton;
    readonly result: { readonly count: number };
  }>
>({
  acquire: Driver.Acquire(() => ({ count: 1 })),
});

// @ts-expect-error fromDriver rejects a spec shape whose declared mode is the full union
nodeSpec.fromDriver<UnionModeCounterSpec>({
  tag: tag("types/counter-union-from-driver-async"),
  key: () => Key.singleton(),
  driver: asyncPlainCounterDriver,
});

// @ts-expect-error fromDriver rejects a spec shape whose declared mode is the full union
nodeSpec.fromDriver<UnionModeCounterSpec>({
  tag: tag("types/counter-union-from-driver-effect"),
  key: () => Key.singleton(),
  driver: effectCounterDriver,
});

// The deleted requirements parameter shifted explicit action maps up one
// position: `.effect<Spec, typeof actions>`, with no middle `never`.
const effectPingActions = {
  ping: Driver.Action(
    (
      _ctx: DriverContext<
        NodeBase<EffectSpec>,
        NodeSpecArgs<EffectSpec>,
        NodeSpecResolvedDeps<EffectSpec>,
        { readonly ok: true }
      >,
      input: { readonly message: string }
    ) => Effect.succeed(input.message.length)
  ),
};

serviceSpec.effect<EffectSpec, typeof effectPingActions>({
  tag: tag("types/effect-explicit-actions"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => Effect.succeed({ ok: true as const })),
  actions: effectPingActions,
});

serviceSpec.async<CounterSpec>({
  tag: tag("types/counter-bare-action"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => ({ count: 1 })),
  actions: {
    // @ts-expect-error bare action functions are not accepted
    bump: (_ctx: unknown, input: { readonly by: number }) => ({ count: input.by }),
  },
});

serviceSpec.async<CounterSpec>({
  tag: tag("types/raw-key"),
  // @ts-expect-error raw keys are not accepted
  key: () => "singleton",
  acquire: Driver.Acquire(() => ({ count: 1 })),
});

type LiveSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: string;
}>;

const liveContractResource = Driver.Live({
  start: (ctx: AsyncLiveContext<NodeBase<LiveSpec>>, demand: ActiveNodeLiveDemandSnapshot) => {
    ctx.node.result satisfies string;
    ctx.signal satisfies AbortSignal;
    demand.isLive satisfies true;
    demand.sources[0] satisfies "manual" | "mobx";
    // Active demand always carries at least one scope: the tuple is non-empty.
    demand.scopes satisfies readonly [unknown, ...ReadonlyArray<unknown>];
    // @ts-expect-error live transition contexts do not own node-scope disposers
    ctx.disposers;
    return { close: () => undefined };
  },
  update: (_ctx, resource, demand) => {
    resource.close satisfies () => void;
    demand.isLive satisfies true;
  },
  stop: (ctx, resource) => {
    ctx.reason satisfies LiveResourceStopReason;
    resource.close();
  },
});

serviceSpec.async<LiveSpec>({
  tag: tag("types/live-ok"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => "ready"),
  live: liveContractResource,
});

serviceSpec.async<LiveSpec>({
  tag: tag("types/live-bad"),
  key: () => Key.singleton(),
  acquire: Driver.Acquire(() => "ready"),
  // @ts-expect-error live hooks must be declared with Driver.Live
  live: async () => undefined,
});

function liveStopReasonLabel(reason: LiveResourceStopReason): string {
  switch (reason._tag) {
    case "DemandInactive":
      return "DemandInactive";
    case "DemandChanged":
      return "DemandChanged";
    case "UpdateFailed":
      return "UpdateFailed";
    case "NodeReleased":
      return "NodeReleased";
    case "NodeEvicted":
      return "NodeEvicted";
    case "GraphStopped":
      return "GraphStopped";
    case "ReadyInvalidated":
      return "ReadyInvalidated";
    case "StartInterrupted":
      return "StartInterrupted";
  }
}

liveStopReasonLabel({ _tag: "DemandInactive" }) satisfies string;

type PlainSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly count: number };
}>;

class PlainNode extends NodeBase<PlainSpec> {
  static readonly spec = nodeSpec.async<PlainSpec>({
    tag: tag("types/plain-node"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(
      (): Promise<{ readonly count: number }> => Promise.resolve({ count: 1 })
    ),
  });

  get count(): number {
    return this.result.count;
  }
}

type FacadeSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly profile: Dep<typeof ProfileNode>;
  };
  readonly result: { readonly ok: true };
}>;

class FacadeNode extends NodeBase<FacadeSpec> {
  static readonly spec = facadeSpec.async<FacadeSpec>({
    tag: tag("types/facade"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      profile: dep(ProfileNode, { id: "profile-5" }),
    })),
    acquire: Driver.Acquire(({ deps }): { readonly ok: true } => {
      deps.profile.rename("Facade") satisfies Promise<{ readonly ok: true }>;
      // Dep-injected instances keep the nominal class type.
      deps.profile satisfies ProfileNode;
      return { ok: true as const };
    }),
  });

  get ok(): true {
    return this.result.ok;
  }
}

type SearchArgs = {
  readonly query: string;
};

type SearchSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: SearchArgs;
  readonly key: Key.Structure<{ readonly query: string }>;
  readonly result: ReadonlyArray<string>;
}>;

class SearchNode extends NodeBase<SearchSpec> {
  static readonly spec = resourceSpec.async<SearchSpec>({
    tag: tag("types/search"),
    key: (args) => Key.structure({ query: args.query }),
    acquire: Driver.Acquire(({ args }) => [args.query]),
  });
}

const plainStarted = await harness.startNode(PlainNode, Args.none);
plainStarted.count satisfies number;
const facadeStarted = await harness.startNode(FacadeNode, Args.none);
facadeStarted.ok satisfies true;
const searchStarted = await harness.startNode(SearchNode, { query: "frond" });
searchStarted.result satisfies ReadonlyArray<string>;

// @ts-expect-error Args.None rejects non-empty args
harness.node(PlainNode, { extra: true });

declare const graphCellView: GraphNodeCellView;
graphCellView.state.getSync() satisfies GraphNodeState;
// @ts-expect-error projection-facing cell views cannot mutate graph cell state
graphCellView.state.transition((state: GraphNodeState) => [undefined, state] as const);
// @ts-expect-error projection-facing cell views cannot replace graph cell state
graphCellView.state.replace(graphCellView.state.getSync());
