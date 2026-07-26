import {
  Async,
  type AsyncActionImplementations,
  type AsyncInput,
  Effect,
  type EffectActionImplementations,
  type EffectInput,
} from "../driver/authoring";
import type { Driver, DriverMode } from "../driver/types";
import type { NodeBase } from "./runtime";
import type {
  AsyncModeSpec,
  DependenciesRecord,
  DependencyResolver,
  EffectModeSpec,
  NodeDescriptor,
  NodeKind,
  NodeSpec,
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecDeclaredDeps,
  NodeSpecKey,
  NodeSpecMode,
  NodeSpecResolvedDeps,
  NodeSpecResult,
  NodeTag,
} from "./types";
import { FROND_DEPENDENCIES_BRAND, FROND_NODE_SPEC_BRAND, FrondNodeSpecError } from "./types";

/**
 * Creates a stable node tag.
 *
 * Use one tag per logical node spec. Tags are graph identity inputs and must not
 * be derived from runtime data, user sessions, or changing configuration.
 */
export function tag(value: string): NodeTag {
  return validateNodeTag(value);
}

/**
 * Marks a dependency resolver as graph-owned dependency topology.
 *
 * Use this for node-to-node dependencies. Do not call runtime clients, start
 * work, or read mutable app state here; planning may evaluate this before
 * readiness begins.
 *
 * Idempotent: an already-branded resolver — including one read back from
 * `descriptor.dependencies` — passes through unchanged.
 */
export function dependencies<TArgs, TDeps extends DependenciesRecord>(
  resolver: (args: TArgs) => TDeps
): DependencyResolver<TArgs, TDeps> {
  if (isBrandedDependencyResolver(resolver)) {
    return resolver;
  }

  return Object.defineProperty(resolver, FROND_DEPENDENCIES_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  }) as unknown as DependencyResolver<TArgs, TDeps>;
}

function isBrandedDependencyResolver<TArgs, TDeps extends DependenciesRecord>(
  resolver: (args: TArgs) => TDeps
): resolver is DependencyResolver<TArgs, TDeps> {
  return (
    (resolver as { readonly [FROND_DEPENDENCIES_BRAND]?: unknown })[FROND_DEPENDENCIES_BRAND] ===
    true
  );
}

/**
 * Node metadata shared by both driver modes.
 *
 * The driver hooks (`acquire`, `actions`, …) live alongside this metadata in the
 * flattened spec input; the mode is chosen by the `.async` / `.effect` factory.
 */
type NodeSpecMeta<
  TSpec extends NodeSpec<{ readonly mode: DriverMode; readonly result?: unknown }>,
> = {
  readonly tag: NodeTag;
  readonly key: (args: NodeSpecArgs<TSpec>) => NodeSpecKey<TSpec>;
  readonly dependencies?:
    | DependencyResolver<NodeSpecArgs<TSpec>, NodeSpecDeclaredDeps<TSpec>>
    | undefined;
};

/**
 * Flattened input for an async-mode node: metadata plus Promise-facing driver
 * hooks. Passed to `nodeSpec.async` / `serviceSpec.async` / etc.
 */
export type AsyncNodeSpecInput<
  TSpec extends AsyncModeSpec,
  TActions extends AsyncActionImplementations<TSpec> = AsyncActionImplementations<TSpec>,
> = NodeSpecMeta<TSpec> & AsyncInput<TSpec, TActions>;

/**
 * Flattened input for an effect-mode node: metadata plus Effect-native driver
 * hooks. Passed to `nodeSpec.effect` / `serviceSpec.effect` / etc.
 */
export type EffectNodeSpecInput<
  TSpec extends EffectModeSpec,
  TActions extends EffectActionImplementations<TSpec> = EffectActionImplementations<TSpec>,
> = NodeSpecMeta<TSpec> & EffectInput<TSpec, TActions>;

/**
 * A mode-flavored node spec factory.
 *
 * `.async` builds a Promise-facing node whose actions are Promise-native; `.effect`
 * builds an Effect-native node whose actions are Effect-native. The mode is
 * declared once, in the spec shape (`NodeSpec<{ mode: "effect"; ... }>`); each
 * flavor rejects a shape whose mode disagrees, and the descriptor type fixes
 * the mode so the public action surface follows it.
 */
export interface NodeSpecFactory {
  readonly async: <
    TSpec extends AsyncModeSpec,
    TActions extends AsyncActionImplementations<TSpec> = AsyncActionImplementations<TSpec>,
  >(
    input: AsyncNodeSpecInput<TSpec, TActions>
  ) => NodeDescriptor<TSpec, "async">;
  readonly effect: <
    TSpec extends EffectModeSpec,
    TActions extends EffectActionImplementations<TSpec> = EffectActionImplementations<TSpec>,
  >(
    input: EffectNodeSpecInput<TSpec, TActions>
  ) => NodeDescriptor<TSpec, "effect">;
  // Escape hatch for a pre-built driver (deferred/mock test drivers, or a driver
  // shared across nodes). Prefer `.async` / `.effect` for authored nodes. The
  // driver's mode literal must agree with the shape-declared mode.
  readonly fromDriver: <
    TSpec extends NodeSpec<{ readonly mode: DriverMode; readonly result?: unknown }>,
    TMode extends NodeSpecMode<TSpec> = NodeSpecMode<TSpec>,
  >(
    input: NodeSpecMeta<TSpec> & {
      readonly driver: Driver<
        NodeBase<TSpec>,
        NodeSpecArgs<TSpec>,
        NodeSpecResolvedDeps<TSpec>,
        NodeSpecResult<TSpec>,
        NodeSpecActions<TSpec>,
        TMode
      >;
    }
  ) => NodeDescriptor<TSpec, TMode>;
}

function makeNodeSpecFactory(kind: NodeKind): NodeSpecFactory {
  return {
    async: <
      TSpec extends AsyncModeSpec,
      TActions extends AsyncActionImplementations<TSpec> = AsyncActionImplementations<TSpec>,
    >(
      input: AsyncNodeSpecInput<TSpec, TActions>
    ): NodeDescriptor<TSpec, "async"> =>
      buildDescriptor<TSpec, "async">(kind, input, Async<TSpec, TActions>(input)),
    effect: <
      TSpec extends EffectModeSpec,
      TActions extends EffectActionImplementations<TSpec> = EffectActionImplementations<TSpec>,
    >(
      input: EffectNodeSpecInput<TSpec, TActions>
    ): NodeDescriptor<TSpec, "effect"> =>
      buildDescriptor<TSpec, "effect">(kind, input, Effect<TSpec, TActions>(input)),
    fromDriver: <
      TSpec extends NodeSpec<{ readonly mode: DriverMode; readonly result?: unknown }>,
      TMode extends NodeSpecMode<TSpec> = NodeSpecMode<TSpec>,
    >(
      input: NodeSpecMeta<TSpec> & {
        readonly driver: Driver<
          NodeBase<TSpec>,
          NodeSpecArgs<TSpec>,
          NodeSpecResolvedDeps<TSpec>,
          NodeSpecResult<TSpec>,
          NodeSpecActions<TSpec>,
          TMode
        >;
      }
    ): NodeDescriptor<TSpec, TMode> => buildDescriptor<TSpec, TMode>(kind, input, input.driver),
  };
}

/**
 * Defines a general node.
 *
 * Prefer `serviceSpec`, `resourceSpec`, or `facadeSpec` when the node has a more
 * specific role; the kind is diagnostic metadata, not a runtime policy. Use the
 * factory flavor (`.async` / `.effect`) that matches the shape-declared mode.
 */
export const nodeSpec: NodeSpecFactory = makeNodeSpecFactory("node");

/**
 * Defines a singleton or keyed service node.
 *
 * Services usually wrap clients, transports, or durable app capabilities. Use the
 * factory flavor (`.async` / `.effect`) that matches the shape-declared mode.
 */
export const serviceSpec: NodeSpecFactory = makeNodeSpecFactory("service");

/**
 * Defines a resource node whose ready result owns cleanup.
 *
 * Use resources for subscriptions, caches, handles, or state that must be
 * released through Frond lifecycle operations instead of React unmounts. Use the
 * factory flavor (`.async` / `.effect`) that matches the shape-declared mode.
 */
export const resourceSpec: NodeSpecFactory = makeNodeSpecFactory("resource");

/**
 * Defines a facade node that presents a domain-facing API over dependencies.
 *
 * Facades keep product code narrow. They do not bypass graph dependency
 * readiness or operation serialization. Use the factory flavor (`.async` /
 * `.effect`) that matches the shape-declared mode.
 */
export const facadeSpec: NodeSpecFactory = makeNodeSpecFactory("facade");

function buildDescriptor<
  TSpec extends NodeSpec<{ readonly mode: DriverMode; readonly result?: unknown }>,
  TMode extends DriverMode,
>(
  kind: NodeKind,
  meta: NodeSpecMeta<TSpec>,
  driver: Driver<
    NodeBase<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>,
    TMode
  >
): NodeDescriptor<TSpec, TMode> {
  const descriptor: NodeDescriptor<TSpec, TMode> = {
    kind,
    tag: validateNodeTag(meta.tag),
    key: meta.key,
    dependencies: dependencyResolver<TSpec>(meta.dependencies),
    driver,
  };

  Object.defineProperties(descriptor, {
    [FROND_NODE_SPEC_BRAND]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
  });

  return descriptor;
}

export function validateNodeTag(value: unknown): NodeTag {
  if (typeof value !== "string") {
    throw new FrondNodeSpecError("Frond node tag must be a string.");
  }

  if (value.trim() !== value || value.length === 0 || /\s/.test(value)) {
    throw new FrondNodeSpecError("Frond node tag must be non-empty and contain no whitespace.");
  }

  return value as NodeTag;
}

const emptyDependencies: DependencyResolver<unknown, Record<string, never>> = dependencies(
  () => ({})
);

function dependencyResolver<
  TSpec extends NodeSpec<{ readonly mode: DriverMode; readonly result?: unknown }>,
>(
  resolver: NodeSpecMeta<TSpec>["dependencies"] | undefined
): NodeDescriptor<TSpec>["dependencies"] {
  if (resolver === undefined) {
    return emptyDependencies as unknown as NodeDescriptor<TSpec>["dependencies"];
  }

  if (resolver[FROND_DEPENDENCIES_BRAND] !== true) {
    throw new FrondNodeSpecError(
      "Frond node dependencies must be created with Frond.dependencies."
    );
  }

  return resolver as unknown as NodeDescriptor<TSpec>["dependencies"];
}
