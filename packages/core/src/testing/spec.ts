import { Effect } from "effect";
import type { Driver } from "../driver";
import { createEffectDriver } from "../driver/effectDefinition";
import {
  type DependenciesRecord,
  FROND_NODE_SPEC_BRAND,
  type FrondNode,
  FrondNodeSpecError,
  type NodeDescriptor,
  type NodeSpec,
  type NodeSpecActions,
  type NodeSpecArgs,
  type NodeSpecClass,
  type NodeSpecDeclaredDeps,
  type NodeSpecInstance,
  type NodeSpecLike,
  type NodeSpecResult,
  type ResolvedDeps,
} from "../node";

type AbstractConstructor = abstract new (...args: ReadonlyArray<never>) => object;

export interface MockSpecOverrides<
  TSpec extends NodeSpecLike,
  TDerivedDeps extends DependenciesRecord = NodeSpecDeclaredDeps<TSpec>,
> {
  readonly driver?:
    | Driver<
        FrondNode<
          NodeSpecArgs<TSpec>,
          ResolvedDeps<TDerivedDeps>,
          NodeSpecResult<TSpec>,
          NodeSpecActions<TSpec>
        >,
        NodeSpecArgs<TSpec>,
        ResolvedDeps<TDerivedDeps>,
        NodeSpecResult<TSpec>,
        NodeSpecActions<TSpec>
      >
    | undefined;
  readonly dependencies?: ((args: NodeSpecArgs<TSpec>) => TDerivedDeps) | undefined;
}

export function mockSpec<
  TSpec extends NodeSpecLike,
  TDerivedDeps extends DependenciesRecord = NodeSpecDeclaredDeps<TSpec>,
>(
  original: TSpec,
  overrides: MockSpecOverrides<TSpec, TDerivedDeps>
): NodeSpecClass<
  NodeSpec<{
    readonly args: NodeSpecArgs<TSpec>;
    readonly deps: TDerivedDeps;
    readonly result: NodeSpecResult<TSpec>;
    readonly actions: NodeSpecActions<TSpec>;
  }>,
  NodeSpecInstance<TSpec>
> {
  return specWithOverrides(original, overrides);
}

export function readySpec<TSpec extends NodeSpecLike>(
  original: TSpec,
  result: NodeSpecResult<TSpec>
): NodeSpecClass<
  NodeSpec<{
    readonly args: NodeSpecArgs<TSpec>;
    readonly deps: Record<string, never>;
    readonly result: NodeSpecResult<TSpec>;
    readonly actions: NodeSpecActions<TSpec>;
  }>,
  NodeSpecInstance<TSpec>
> {
  return specWithOverrides(original, {
    dependencies: () => ({}),
    driver: createEffectDriver<
      FrondNode<
        NodeSpecArgs<TSpec>,
        ResolvedDeps<Record<string, never>>,
        NodeSpecResult<TSpec>,
        NodeSpecActions<TSpec>
      >,
      ResolvedDeps<Record<string, never>>,
      NodeSpecResult<TSpec>,
      NodeSpecArgs<TSpec>,
      Record<string, never>
    >({
      acquire: () => Effect.succeed(result),
    }) as Driver<
      FrondNode<
        NodeSpecArgs<TSpec>,
        ResolvedDeps<Record<string, never>>,
        NodeSpecResult<TSpec>,
        NodeSpecActions<TSpec>
      >,
      NodeSpecArgs<TSpec>,
      ResolvedDeps<Record<string, never>>,
      NodeSpecResult<TSpec>,
      NodeSpecActions<TSpec>
    >,
  });
}

function specWithOverrides<
  TOriginal extends NodeSpecLike,
  TDerivedDeps extends DependenciesRecord = NodeSpecDeclaredDeps<TOriginal>,
>(
  original: TOriginal,
  overrides: MockSpecOverrides<TOriginal, TDerivedDeps>
): NodeSpecClass<
  NodeSpec<{
    readonly args: NodeSpecArgs<TOriginal>;
    readonly deps: TDerivedDeps;
    readonly result: NodeSpecResult<TOriginal>;
    readonly actions: NodeSpecActions<TOriginal>;
  }>,
  NodeSpecInstance<TOriginal>
> {
  assertStaticNodeSpec(original);

  const descriptor = original.spec as NodeDescriptor<
    NodeSpec<{
      readonly args: NodeSpecArgs<TOriginal>;
      readonly deps: NodeSpecDeclaredDeps<TOriginal>;
      readonly result: NodeSpecResult<TOriginal>;
      readonly actions: NodeSpecActions<TOriginal>;
    }>
  >;
  const overrideDescriptor = {
    kind: descriptor.kind,
    tag: descriptor.tag,
    key: descriptor.key,
    dependencies: overrides.dependencies ?? descriptor.dependencies,
    driver: overrides.driver ?? descriptor.driver,
  };
  Object.defineProperty(overrideDescriptor, FROND_NODE_SPEC_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  abstract class SpecOverride extends (original as unknown as AbstractConstructor) {
    static readonly spec = overrideDescriptor;
  }

  return SpecOverride as unknown as NodeSpecClass<
    NodeSpec<{
      readonly args: NodeSpecArgs<TOriginal>;
      readonly deps: TDerivedDeps;
      readonly result: NodeSpecResult<TOriginal>;
      readonly actions: NodeSpecActions<TOriginal>;
    }>,
    NodeSpecInstance<TOriginal>
  >;
}

function assertStaticNodeSpec(value: unknown): asserts value is NodeSpecLike {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    (value as { readonly spec?: unknown }).spec === undefined
  ) {
    throw new FrondNodeSpecError("Frond testing spec helpers expect a node spec with static spec.");
  }
}
