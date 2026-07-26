import { Effect } from "effect";
import type { Dep, NodeSpecInstance } from "../../src";
import {
  Args,
  createRuntime,
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  nodeSpec,
  serviceSpec,
  specWithDriver,
  tag,
} from "../../src";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

type TransportSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly transport: string };
}>;

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec.async<TransportSpec>({
    tag: tag("types/with-driver-transport"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => ({ transport: "real" })),
  });

  get transport(): string {
    return this.result.transport;
  }
}

type ConsumerSpec = import("../../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly deps: { readonly transport: Dep<typeof TransportNode> };
  readonly result: { readonly seen: string };
}>;

class ConsumerNode extends NodeBase<ConsumerSpec> {
  static readonly spec = serviceSpec.async<ConsumerSpec>({
    tag: tag("types/with-driver-consumer"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ transport: dep(TransportNode, Args.none) })),
    acquire: Driver.Acquire((ctx) => ({ seen: ctx.deps.transport.transport })),
  });
}

type EffectTransportSpec = import("../../src").NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly transport: string };
}>;

class EffectTransportNode extends NodeBase<EffectTransportSpec> {
  static readonly spec = serviceSpec.effect<EffectTransportSpec>({
    tag: tag("types/with-driver-effect-transport"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => Effect.succeed({ transport: "real" })),
  });
}

const asyncReplacement = Driver.Async<TransportSpec>({
  acquire: Driver.Acquire(() => ({ transport: "injected" })),
});

const effectReplacement = Driver.Effect<EffectTransportSpec>({
  acquire: Driver.Acquire(() => Effect.succeed({ transport: "injected" })),
});

// specWithDriver accepts a replacement driver whose mode literal agrees with
// the original spec shape's declared mode...
const OverriddenTransport = specWithDriver(TransportNode, asyncReplacement);
const OverriddenEffectTransport = specWithDriver(EffectTransportNode, effectReplacement);

// ...and rejects one whose mode disagrees (the fromDriver must-agree machinery).
// @ts-expect-error specWithDriver rejects a driver whose mode disagrees with the shape mode
specWithDriver(TransportNode, effectReplacement);
// @ts-expect-error specWithDriver rejects a driver whose mode disagrees with the shape mode
specWithDriver(EffectTransportNode, asyncReplacement);

// The override is assignable where the original class is expected.
const transportSlot: typeof TransportNode = OverriddenTransport;
const effectTransportSlot: typeof EffectTransportNode = OverriddenEffectTransport;
void transportSlot;
void effectTransportSlot;

// A dependency declared against the original accepts the override.
const overriddenDep: Dep<typeof TransportNode> = dep(OverriddenTransport, Args.none);
void overriddenDep;

// The override instance type is exactly the original instance type, so ready
// handles keep prototype-authored members.
export type OverriddenInstanceOfNodeSpec = Expect<
  Equal<NodeSpecInstance<typeof OverriddenTransport>, TransportNode>
>;
declare const overriddenInstance: InstanceType<typeof OverriddenTransport>;
const asOriginalInstance: TransportNode = overriddenInstance;
void asOriginalInstance;

// The override mirrors the original's abstractness: a concrete original keeps
// a concrete construct signature (parity with authored node classes; direct
// construction still throws FrondNodeConstructionUnavailable at runtime), and
// an abstract original yields an abstract override.
void new OverriddenTransport();

abstract class AbstractTransportNode extends TransportNode {
  abstract label(): string;
}

const OverriddenAbstractTransport = specWithDriver(AbstractTransportNode, asyncReplacement);
// @ts-expect-error an override of an abstract original stays abstract
new OverriddenAbstractTransport();
const abstractSlot: typeof AbstractTransportNode = OverriddenAbstractTransport;
void abstractSlot;

// The override is accepted by createRuntime specOverrides and the client.
const runtime = createRuntime({
  specOverrides: [{ from: TransportNode, to: OverriddenTransport }],
});
const handle = runtime.client.node(OverriddenTransport, Args.none);
void handle;

// A branded resolver read back from a descriptor is accepted by the public
// factories directly — no `dependencies(args => resolver(args))` closure.
nodeSpec.fromDriver<ConsumerSpec>({
  tag: ConsumerNode.spec.tag,
  key: ConsumerNode.spec.key,
  dependencies: ConsumerNode.spec.dependencies,
  driver: Driver.Async<ConsumerSpec>({
    acquire: Driver.Acquire((ctx) => ({ seen: ctx.deps.transport.transport })),
  }),
});

// ...and stays callable as a plain resolver.
export type ResolverStaysCallable = Expect<
  Equal<
    ReturnType<typeof ConsumerNode.spec.dependencies>,
    { readonly transport: Dep<typeof TransportNode> }
  >
>;

// An unbranded plain function is still rejected at the type level.
serviceSpec.async<ConsumerSpec>({
  tag: tag("types/with-driver-unbranded"),
  key: () => Key.singleton(),
  // @ts-expect-error factories require a resolver branded via dependencies(...)
  dependencies: () => ({ transport: dep(TransportNode, Args.none) }),
  acquire: Driver.Acquire((ctx) => ({ seen: ctx.deps.transport.transport })),
});
