import { Effect } from "effect";
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
} from "../../src";
import type { GraphNodeCellView, GraphNodeState } from "../../src/graph/planning/plan";
import { createFrondTestHarness, mockSpec, readySpec } from "../../src/testing";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

type TransportSpec = import("../../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: TransportResult;
}>;

type TransportResult = {
  readonly token: string;
};

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec<TransportSpec>({
    tag: tag("types/transport"),
    key: () => Key.singleton(),
    driver: Driver.Async<TransportSpec>({
      acquire: Driver.Acquire((): TransportResult => ({ token: "token" })),
    }),
  });

  get bearer(): string {
    return `Bearer ${this.result.token}`;
  }
}

type CounterSpec = import("../../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly count: number };
  readonly actions: {
    readonly bump: ActionContract<{ readonly by: number }, { readonly count: number }>;
  };
}>;

class CounterNode extends NodeBase<CounterSpec> {
  static readonly spec = serviceSpec<CounterSpec>({
    tag: tag("types/counter"),
    key: () => Key.singleton(),
    driver: Driver.Async<CounterSpec>({
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
    }),
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
    _ctx.refreshDep("transport") satisfies Promise<TransportNode>;
    // @ts-expect-error driver dependency refresh is limited to declared dependency names
    _ctx.refreshDep("missing");
    input.name satisfies string;
    return { ok: true as const };
  }),
};

class ProfileNode extends NodeBase<ProfileSpec> {
  static readonly spec = resourceSpec<ProfileSpec>({
    tag: tag("types/profile"),
    key: (args) => Key.structure({ id: args.id }),
    dependencies: dependencies((args: ProfileArgs) => {
      args.id satisfies string;
      return {
        transport: dep(TransportNode, Args.none),
      };
    }),
    driver: Driver.Async<ProfileSpec, typeof profileActions>({
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
    }),
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
const started = await harness.startNode(ProfileNode, { id: "profile-4" });
started.rename("Dorothy") satisfies Promise<{ readonly ok: true }>;

const mocked = mockSpec(ProfileNode, {
  driver: Driver.Async<ProfileSpec, typeof profileActions>({
    acquire: Driver.Acquire((): ProfileResult => ({ name: "Mocked" })),
    actions: profileActions,
  }),
});
const ready = readySpec(ProfileNode, { name: "Ready" });
harness.node(mocked, { id: "mocked" });
harness.node(ready, { id: "ready" });

// @ts-expect-error dependency args are checked against dependency spec args
dep(TransportNode, { id: "wrong" });

type EffectSpec = import("../../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly ok: true };
  readonly actions: {
    readonly ping: ActionContract<{ readonly message: string }, number>;
  };
}>;

type EffectProfileContext = DriverContext<
  NodeBase<ProfileSpec>,
  ProfileArgs,
  NodeSpecResolvedDeps<ProfileSpec>,
  ProfileResult
>;

Driver.Effect<ProfileSpec>({
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
  static readonly spec = serviceSpec<EffectSpec>({
    tag: tag("types/effect"),
    key: () => Key.singleton(),
    driver: Driver.Effect<EffectSpec>({
      acquire: Driver.Acquire(() => Effect.succeed({ ok: true as const })),
      actions: {
        ping: Driver.Action((_ctx, input: { readonly message: string }) =>
          Effect.succeed(input.message.length)
        ),
      },
    }),
  });
}

const effectStarted = await harness.startNode(EffectNode, Args.none);
effectStarted.actions.ping({ message: "effect" }) satisfies Promise<number>;
// @ts-expect-error inferred effect action input is checked
effectStarted.actions.ping({ message: 1 });

Driver.Async<CounterSpec>({
  // @ts-expect-error async drivers must not return Effect values
  acquire: Driver.Acquire(() => Effect.succeed("not async authoring")),
});

Driver.Effect<CounterSpec>({
  // @ts-expect-error effect drivers must return Effect values
  acquire: Driver.Acquire(() => "not effect authoring"),
});

Driver.Async<CounterSpec>({
  acquire: Driver.Acquire(() => ({ count: 1 })),
  actions: {
    // @ts-expect-error bare action functions are not accepted
    bump: (_ctx: unknown, input: { readonly by: number }) => ({ count: input.by }),
  },
});

serviceSpec<CounterSpec>({
  tag: tag("types/raw-key"),
  // @ts-expect-error raw keys are not accepted
  key: () => "singleton",
  driver: Driver.Async<CounterSpec>({
    acquire: Driver.Acquire(() => ({ count: 1 })),
  }),
});

type LiveSpec = import("../../src").NodeSpec<{
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
    demand.scopes[0] satisfies unknown;
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

Driver.Async<LiveSpec>({
  acquire: Driver.Acquire(() => "ready"),
  live: liveContractResource,
});

Driver.Async<LiveSpec>({
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
  }
}

liveStopReasonLabel({ _tag: "DemandInactive" }) satisfies string;

type PlainSpec = import("../../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly count: number };
}>;

class PlainNode extends NodeBase<PlainSpec> {
  static readonly spec = nodeSpec<PlainSpec>({
    tag: tag("types/plain-node"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Async<PlainSpec>({
      acquire: Driver.Acquire(
        (): Promise<{ readonly count: number }> => Promise.resolve({ count: 1 })
      ),
    }),
  });

  get count(): number {
    return this.result.count;
  }
}

type FacadeSpec = import("../../src").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly profile: Dep<typeof ProfileNode>;
  };
  readonly result: { readonly ok: true };
}>;

class FacadeNode extends NodeBase<FacadeSpec> {
  static readonly spec = facadeSpec<FacadeSpec>({
    tag: tag("types/facade"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      profile: dep(ProfileNode, { id: "profile-5" }),
    })),
    driver: Driver.Async<FacadeSpec>({
      acquire: Driver.Acquire(({ deps }): { readonly ok: true } => {
        deps.profile.rename("Facade") satisfies Promise<{ readonly ok: true }>;
        return { ok: true as const };
      }),
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
  readonly args: SearchArgs;
  readonly key: Key.Structure<{ readonly query: string }>;
  readonly result: ReadonlyArray<string>;
}>;

class SearchNode extends NodeBase<SearchSpec> {
  static readonly spec = resourceSpec<SearchSpec>({
    tag: tag("types/search"),
    key: (args) => Key.structure({ query: args.query }),
    driver: Driver.Async<SearchSpec>({
      acquire: Driver.Acquire(({ args }) => [args.query]),
    }),
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
