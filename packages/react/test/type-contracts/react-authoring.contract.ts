import {
  type ActionContract,
  Args,
  type AsyncDriverContext,
  type Dep,
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  type NodeSpecArgs,
  type NodeSpecResolvedDeps,
  resourceSpec,
  serviceSpec,
  tag,
} from "@frondruntime/core";
import { Effect } from "effect";
import {
  Preload,
  useNode,
  useNodeControls,
  useNodeState,
  useNodes,
  useNodesControls,
} from "../../src";

type TransportResult = {
  readonly token: string;
};

type TransportSpec = import("@frondruntime/core").NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: TransportResult;
}>;

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec<TransportSpec>({
    tag: tag("react-types/transport"),
    key: () => Key.singleton(),
    driver: Driver.Effect<TransportSpec>({
      acquire: Driver.Acquire(() => Effect.succeed({ token: "token" } satisfies TransportResult)),
    }),
  });

  get bearer(): string {
    return `Bearer ${this.result.token}`;
  }
}

type ProfileArgs = {
  readonly id: string;
};

type ProfileResult = {
  readonly name: string;
};

type ProfileActions = {
  readonly rename: ActionContract<{ readonly name: string }, { readonly ok: true }>;
};

type ProfileDeps = {
  readonly transport: Dep<typeof TransportNode>;
};

type ProfileSpec = import("@frondruntime/core").NodeSpec<{
  readonly args: ProfileArgs;
  readonly key: Key.Structure<{ readonly id: string }>;
  readonly deps: ProfileDeps;
  readonly result: ProfileResult;
  readonly actions: ProfileActions;
}>;

type ProfileNodeContext = AsyncDriverContext<
  NodeBase<ProfileSpec>,
  NodeSpecArgs<ProfileSpec>,
  NodeSpecResolvedDeps<ProfileSpec>,
  ProfileResult
>;

const profileActions = {
  rename: Driver.Action((_ctx: ProfileNodeContext, input: { readonly name: string }) => {
    input.name satisfies string;
    return { ok: true as const };
  }),
};

class ProfileNode extends NodeBase<ProfileSpec> {
  static readonly spec = resourceSpec<ProfileSpec>({
    tag: tag("react-types/profile"),
    key: (args) => Key.structure({ id: args.id }),
    dependencies: dependencies(() => ({
      transport: dep(TransportNode, Args.none),
    })),
    driver: Driver.Async<ProfileSpec, typeof profileActions>({
      acquire: Driver.Acquire((): ProfileResult => ({ name: "Ada" })),
      actions: profileActions,
    }),
  });

  rename(name: string): Promise<{ readonly ok: true }> {
    return this.actions.rename({ name });
  }
}

function ReactTypeContractProbe(): null {
  const profile = useNode(ProfileNode, { id: "profile-1" });
  profile.rename("Grace") satisfies Promise<{ readonly ok: true }>;
  profile.actions.rename({ name: "Grace" }) satisfies Promise<{ readonly ok: true }>;
  profile.deps.transport.bearer satisfies string;
  profile.result.name satisfies string;

  const profileState = useNodeState(ProfileNode, { id: "profile-state" });
  profileState.node.rename("Mary") satisfies Promise<{ readonly ok: true }>;
  profileState.busy satisfies boolean;
  profileState.operation satisfies import("@frondruntime/core").Graph.NodeOperation;
  profileState.operationFailure satisfies
    | import("@frondruntime/core").Graph.NodeOperationFailure
    | undefined;
  profileState.resultValidity satisfies import("@frondruntime/core").Graph.ResultValidity;

  // @ts-expect-error node state does not expose raw driver result separately
  profileState.result;

  // @ts-expect-error node state does not expose imperative controls
  profileState.refresh;

  const controls = useNodeControls(ProfileNode, { id: "profile-controls" });
  controls.releaseResources() satisfies Promise<void>;

  const controlsMap = useNodesControls({
    profile: [ProfileNode, { id: "profile-controls-map" }],
    transport: [TransportNode, Args.none],
  });
  controlsMap.profile.refresh() satisfies Promise<import("@frondruntime/core").Graph.RefreshResult>;
  controlsMap.transport.ensureReady() satisfies Promise<void>;

  const nodes = useNodes({
    profile: [ProfileNode, { id: "profile-2" }],
    transport: [TransportNode, Args.none],
  });
  nodes.profile.rename("Katherine") satisfies Promise<{ readonly ok: true }>;
  nodes.transport.bearer satisfies string;

  Preload({
    children: null,
    nodes: [{ profile: [ProfileNode, { id: "preload-profile" }] }],
  });

  useNodes({
    // @ts-expect-error useNodes dependency args are checked
    profile: [ProfileNode, Args.none],
  });

  useNodesControls({
    // @ts-expect-error useNodesControls dependency args are checked
    profile: [ProfileNode, Args.none],
  });

  Preload({
    children: null,
    nodes: [
      {
        // @ts-expect-error Preload dependency args are checked
        profile: [ProfileNode, Args.none],
      },
    ],
  });

  // @ts-expect-error node args are checked
  useNode(ProfileNode, Args.none);

  // @ts-expect-error action input is checked
  profile.rename(123);

  // @ts-expect-error generated action input is checked
  profile.actions.rename({ name: 123 });

  return null;
}

ReactTypeContractProbe satisfies () => null;
