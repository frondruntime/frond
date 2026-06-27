import * as Frond from "@frondruntime/core";
import * as FrondTesting from "@frondruntime/core/testing";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

const channel = Frond.Signals.channel("types/channel");
const definedChannel = Frond.Signals.defineChannel({
  name: "types/defined-channel",
  policy: { retention: "bounded", bufferSize: 2 },
});
const signal = Frond.Signals.signal({
  channel,
  name: "typed",
});
const definedSignal = definedChannel.signal("typed-defined");

signal satisfies Frond.Signals.RuntimeSignal;
definedSignal satisfies Frond.Signals.RuntimeSignal;
channel satisfies Frond.Signals.RuntimeSignalChannel;
definedChannel satisfies Frond.Signals.RuntimeSignalChannelDefinition;
definedChannel.channel satisfies Frond.Signals.RuntimeSignalChannel;
({ channels: [definedChannel] }) satisfies Frond.Runtime.RuntimeOptions;

type RuntimeHandle = Frond.Runtime.RuntimeNodeHandle<Frond.Args.None, { readonly ok: true }>;
type RuntimeRead = Frond.Runtime.RuntimeNodeRead<{ readonly ok: true }>;
type UnsafeRead = Frond.Runtime.UnsafeNodeRead;
type RuntimeSnapshot = Frond.Runtime.RuntimeNodeSnapshot<{ readonly ok: true }>;
type RuntimeEvent = Frond.Runtime.RuntimeEvent;
type RuntimeEventRecord = Frond.Runtime.RuntimeEventRecord;
type RuntimeClassification = Frond.Events.RuntimeEventClassification;
type GraphNodeId = Frond.Graph.NodeId;
type GraphFailure = Frond.Graph.GraphFailure;
type GraphSnapshot = Frond.Graph.NodeSnapshot;
type MobXNode = Frond.MobX.MobXNode<Frond.Args.None, object, { readonly ok: true }, object>;

export type PublicSurfaceTypes = [
  RuntimeHandle,
  RuntimeRead,
  RuntimeSnapshot,
  RuntimeEvent,
  RuntimeEventRecord,
  RuntimeClassification,
  GraphNodeId,
  GraphFailure,
  GraphSnapshot,
  MobXNode,
];

export type EffectBoundaryFailedIsGraphFailure = Expect<
  Frond.Graph.EffectBoundaryFailed extends Frond.Graph.GraphFailure ? true : false
>;
export type RuntimeControlOnlySetInputIngestion = Expect<
  Equal<Frond.Runtime.RuntimeControl["_tag"], "SetInputIngestion">
>;
export type PublicRuntimeReadTags = Expect<
  Equal<RuntimeRead["_tag"], "Unwired" | "Idle" | "Pending" | "Ready" | "Error">
>;
export type PublicRuntimeErrorKinds = Expect<
  Equal<
    Extract<RuntimeRead, { readonly _tag: "Error" }>["kind"],
    "readiness" | "invalid" | "runtime"
  >
>;
export type PublicReadyValidityIsDisplayable = Expect<
  Equal<
    Extract<RuntimeRead, { readonly _tag: "Ready" }>["resultValidity"]["_tag"],
    "Current" | "Stale"
  >
>;
export type UnsafeReadKeepsRawTags = Expect<
  Equal<
    UnsafeRead["_tag"],
    | "Unwired"
    | "Idle"
    | "Pending"
    | "Booting"
    | "Ready"
    | "Expired"
    | "Error"
    | "Unavailable"
    | "Invalid"
  >
>;

export type NoRootRuntimeNodeHandle = Expect<
  Equal<"RuntimeNodeHandle" extends keyof typeof Frond ? true : false, false>
>;
export type NoRootRuntimeSignalRecord = Expect<
  Equal<"RuntimeSignalRecord" extends keyof typeof Frond ? true : false, false>
>;
export type NoRootTestingNamespace = Expect<
  Equal<"Testing" extends keyof typeof Frond ? true : false, false>
>;
export type NoRootKeysAlias = Expect<
  Equal<"Keys" extends keyof typeof Frond ? true : false, false>
>;
export type RootKeyNamespace = Expect<Equal<"Key" extends keyof typeof Frond ? true : false, true>>;
export type NoRuntimeHostConstructor = Expect<
  Equal<"makeRuntimeHost" extends keyof typeof Frond.Runtime ? true : false, false>
>;
export type NoRuntimeHostBridge = Expect<
  Equal<"bridgeRuntimeHost" extends keyof typeof Frond.Runtime ? true : false, false>
>;
export type NoRuntimeEffectLayer = Expect<
  Equal<"FrondRuntimeLive" extends keyof typeof Frond.Runtime ? true : false, false>
>;
export type NoRuntimeEffectService = Expect<
  Equal<"FrondRuntime" extends keyof typeof Frond.Runtime ? true : false, false>
>;
export type NoRuntimeSignalBus = Expect<
  Equal<"RuntimeSignalBus" extends keyof typeof Frond.Signals ? true : false, false>
>;
export type NoNormalizedDriverContext = Expect<
  Equal<"NormalizedDriverContext" extends keyof typeof Frond.Driver ? true : false, false>
>;
export type NoGraphSystemConstructor = Expect<
  Equal<"makeInMemoryGraphSystem" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoGraphSystemService = Expect<
  Equal<"GraphSystemService" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoGraphSystem = Expect<
  Equal<"GraphSystem" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoGraphInput = Expect<
  Equal<"GraphInput" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoGraphTask = Expect<
  Equal<"GraphTask" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoProjectionContext = Expect<
  Equal<"ProjectionContext" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoGraphObserverTypes = Expect<
  Equal<"GraphObserverChannel" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoRefreshSubmission = Expect<
  Equal<"RefreshSubmission" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type NoUnsafeUpdateRequest = Expect<
  Equal<"UnsafeUpdateNodeRequest" extends keyof typeof Frond.Graph ? true : false, false>
>;
export type PublicGraphKeepsConsumerTypes = [
  Frond.Graph.NodeId,
  Frond.Graph.NodeRead,
  Frond.Graph.NodeSnapshot,
  Frond.Graph.ActionResult,
  Frond.Graph.RefreshResult,
  Frond.Graph.UpdateNodeArgsResult,
  Frond.Graph.EvictResult,
  Frond.Graph.EvictMode,
  Frond.Graph.ResultValidity,
  Frond.Graph.GraphFailure,
];

// @ts-expect-error RuntimeNodeHandle is namespace-owned under Frond.Runtime.
export type RootRuntimeNodeHandle = Frond.RuntimeNodeHandle<Frond.Args.None, { readonly ok: true }>;

// @ts-expect-error RuntimeSignalRecord is namespace-owned under Frond.Signals.
export type RootRuntimeSignalRecord = Frond.RuntimeSignalRecord;

// @ts-expect-error MobXNode is namespace-owned under Frond.MobX.
export type RootMobXNode = Frond.MobXNode<Frond.Args.None, object, { readonly ok: true }, object>;

// @ts-expect-error Keys alias was removed; use Frond.Key.
Frond.Keys.singleton;

// @ts-expect-error Runtime host constructors are internal.
Frond.Runtime.makeRuntimeHost;

// @ts-expect-error Runtime host bridge is internal.
Frond.Runtime.bridgeRuntimeHost;

// @ts-expect-error Effect runtime layer is internal until a public Effect app surface is designed.
Frond.Runtime.FrondRuntimeLive;

// @ts-expect-error Effect runtime service is internal until a public Effect app surface is designed.
Frond.Runtime.FrondRuntime;

// @ts-expect-error Runtime signal bus is an internal Effect service.
Frond.Signals.RuntimeSignalBus;

// @ts-expect-error Normalized driver contexts are internal.
export type NormalizedContext = Frond.Driver.NormalizedDriverContext<
  object,
  object,
  object,
  object
>;

// @ts-expect-error Graph system constructor is internal/testing-only.
Frond.Graph.makeInMemoryGraphSystem;

// @ts-expect-error Graph system service is internal.
export type PublicGraphSystemService = Frond.Graph.GraphSystemService;

// @ts-expect-error Graph system service class is internal.
Frond.Graph.GraphSystem;

// @ts-expect-error Graph input plumbing is internal.
export type PublicGraphInput = Frond.Graph.GraphInput;

// @ts-expect-error Graph tasks are internal actor plumbing.
export type PublicGraphTask = Frond.Graph.GraphTask<unknown>;

// @ts-expect-error Projection context is internal snapshot plumbing.
export type PublicProjectionContext = Frond.Graph.ProjectionContext;

// @ts-expect-error Graph observer channels are internal runtime plumbing.
export type PublicGraphObserverChannel = Frond.Graph.GraphObserverChannel;

// @ts-expect-error Refresh submissions are internal actor admission plumbing.
export type PublicRefreshSubmission = Frond.Graph.RefreshSubmission;

// @ts-expect-error Unsafe update request is internal to Runtime.__unsafe.
export type PublicUnsafeUpdateNodeRequest = Frond.Graph.UnsafeUpdateNodeRequest;

Frond.Key.singleton() satisfies Frond.Key.Singleton;
FrondTesting.createDeferred<number>() satisfies FrondTesting.DeferredTestValue<number>;
