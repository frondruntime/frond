import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Dep } from "../src";
import {
  Args,
  createRuntime,
  Driver,
  dep,
  dependencies,
  FrondNodeSpecError,
  Key,
  NodeBase,
  nodeSpec,
  serviceSpec,
  specWithDriver,
  tag,
} from "../src";

type TransportSpec = import("../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly transport: string };
}>;

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec.async<TransportSpec>({
    tag: tag("tests/with-driver-transport"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => ({ transport: "real" })),
  });

  get transport(): string {
    return this.result.transport;
  }
}

type ConsumerSpec = import("../src").NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly deps: { readonly transport: Dep<typeof TransportNode> };
  readonly result: { readonly seen: string };
}>;

class ConsumerNode extends NodeBase<ConsumerSpec> {
  static readonly spec = serviceSpec.async<ConsumerSpec>({
    tag: tag("tests/with-driver-consumer"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ transport: dep(TransportNode, Args.none) })),
    acquire: Driver.Acquire((ctx) => ({ seen: ctx.deps.transport.transport })),
  });

  get seen(): string {
    return this.result.seen;
  }
}

const replacementDriver = () =>
  Driver.Async<TransportSpec>({
    acquire: Driver.Acquire(() => ({ transport: "injected" })),
  });

describe("specWithDriver", () => {
  test("override boots with the replacement driver and keeps node identity", async () => {
    const OverriddenTransport = specWithDriver(TransportNode, replacementDriver());

    expect(OverriddenTransport.spec.tag).toBe(TransportNode.spec.tag);
    expect(OverriddenTransport.spec.kind).toBe(TransportNode.spec.kind);
    expect(OverriddenTransport.spec.key).toBe(TransportNode.spec.key);
    expect(OverriddenTransport.spec.dependencies).toBe(TransportNode.spec.dependencies);

    const baseline = createRuntime();
    const baselineReady = await baseline.client.node(TransportNode, Args.none).ensureReady();
    expect(baselineReady.node.transport).toBe("real");

    const runtime = createRuntime({
      specOverrides: [{ from: TransportNode, to: OverriddenTransport }],
    });
    const ready = await runtime.client.node(TransportNode, Args.none).ensureReady();

    expect(ready.node).toBeInstanceOf(TransportNode);
    expect(ready.node.transport).toBe("injected");
    expect(ready.node.nodeId).toBe(baselineReady.node.nodeId);
  });

  test("a dependent node still resolves through the overridden spec (deps preserved)", async () => {
    const OverriddenTransport = specWithDriver(TransportNode, replacementDriver());
    const runtime = createRuntime({
      specOverrides: [{ from: TransportNode, to: OverriddenTransport }],
    });

    const ready = await runtime.client.node(ConsumerNode, Args.none).ensureReady();

    expect(ready.node).toBeInstanceOf(ConsumerNode);
    expect(ready.node.seen).toBe("injected");
  });

  test("an override of a node WITH dependencies keeps the dependency topology", async () => {
    let observed: unknown;
    const OverriddenConsumer = specWithDriver(
      ConsumerNode,
      Driver.Async<ConsumerSpec>({
        acquire: Driver.Acquire((ctx) => {
          observed = ctx.deps.transport;
          return { seen: `override:${ctx.deps.transport.transport}` };
        }),
      })
    );

    expect(OverriddenConsumer.spec.dependencies).toBe(ConsumerNode.spec.dependencies);

    const runtime = createRuntime({
      specOverrides: [{ from: ConsumerNode, to: OverriddenConsumer }],
    });
    const ready = await runtime.client.node(ConsumerNode, Args.none).ensureReady();

    expect(ready.node.seen).toBe("override:real");
    expect(observed).toBeInstanceOf(TransportNode);
  });

  test("rejects a replacement driver whose mode disagrees at runtime", () => {
    const effectDriver = Driver.Effect<
      import("../src").NodeSpec<{
        readonly mode: "effect";
        readonly args: Args.None;
        readonly key: Key.Singleton;
        readonly result: { readonly transport: string };
      }>
    >({
      acquire: Driver.Acquire(() => Effect.succeed({ transport: "injected" })),
    });

    expect(() =>
      specWithDriver(TransportNode, effectDriver as unknown as ReturnType<typeof replacementDriver>)
    ).toThrow(FrondNodeSpecError);
    expect(() =>
      specWithDriver(TransportNode, effectDriver as unknown as ReturnType<typeof replacementDriver>)
    ).toThrow('must agree with the original spec\'s driver mode "async"');
  });

  test("rejects replacements that are not normalized drivers and originals without a spec", () => {
    expect(() =>
      specWithDriver(TransportNode, (() => ({})) as unknown as ReturnType<typeof replacementDriver>)
    ).toThrow("must be built with Driver.Async or Driver.Effect");

    class NotASpec {}
    expect(() =>
      specWithDriver(NotASpec as unknown as typeof TransportNode, replacementDriver())
    ).toThrow("static branded spec");
  });
});

describe("branded dependency resolvers round-trip", () => {
  test("dependencies() passes an already-branded resolver through unchanged", () => {
    const resolver = dependencies(() => ({ transport: dep(TransportNode, Args.none) }));
    expect(dependencies(resolver)).toBe(resolver);
    expect(dependencies(ConsumerNode.spec.dependencies)).toBe(ConsumerNode.spec.dependencies);
  });

  test("a descriptor's resolver is accepted by the public factories without a closure wrapper", async () => {
    const descriptor = ConsumerNode.spec;
    const rebuilt = nodeSpec.fromDriver<ConsumerSpec>({
      tag: descriptor.tag,
      key: descriptor.key,
      dependencies: descriptor.dependencies,
      driver: Driver.Async<ConsumerSpec>({
        acquire: Driver.Acquire((ctx) => ({ seen: `rebuilt:${ctx.deps.transport.transport}` })),
      }),
    });

    expect(rebuilt.dependencies).toBe(descriptor.dependencies);

    class RebuiltConsumerNode extends NodeBase<ConsumerSpec> {
      static readonly spec = rebuilt;
    }

    const runtime = createRuntime();
    const ready = await runtime.client.node(RebuiltConsumerNode, Args.none).ensureReady();
    expect(ready.node.result.seen).toBe("rebuilt:real");
  });

  test("unbranded plain functions are still rejected by the factories", () => {
    expect(() =>
      serviceSpec.async<ConsumerSpec>({
        tag: tag("tests/with-driver-unbranded"),
        key: () => Key.singleton(),
        dependencies: (() => ({
          transport: dep(TransportNode, Args.none),
        })) as unknown as typeof ConsumerNode.spec.dependencies,
        acquire: Driver.Acquire((ctx) => ({ seen: ctx.deps.transport.transport })),
      })
    ).toThrow("must be created with Frond.dependencies");
  });
});
