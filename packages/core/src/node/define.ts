import type {
  DependenciesRecord,
  DependencyResolver,
  NodeDescriptor,
  NodeKind,
  NodeSpec,
  NodeSpecInput,
  NodeSpecLike,
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
 */
export function dependencies<TArgs, TDeps extends DependenciesRecord>(
  resolver: (args: TArgs) => TDeps
): DependencyResolver<TArgs, TDeps> {
  return Object.defineProperty(resolver, FROND_DEPENDENCIES_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  }) as unknown as DependencyResolver<TArgs, TDeps>;
}

/**
 * Defines a general node spec.
 *
 * Prefer `serviceSpec`, `resourceSpec`, or `facadeSpec` when the node has a
 * more specific role; the kind is diagnostic metadata, not a runtime policy.
 */
export function nodeSpec<TSpec extends NodeSpec<{ readonly result?: unknown }>>(
  spec: NodeSpecInput<TSpec>
): NodeDescriptor<TSpec> {
  return nodeSpecWithKind("node", spec);
}

/**
 * Defines a singleton or keyed service node.
 *
 * Services usually wrap clients, transports, or durable app capabilities. They
 * still participate in graph identity, readiness, release, and eviction.
 */
export function serviceSpec<TSpec extends NodeSpec<{ readonly result?: unknown }>>(
  spec: NodeSpecInput<TSpec>
): NodeDescriptor<TSpec> {
  return nodeSpecWithKind("service", spec);
}

/**
 * Defines a resource node whose ready result owns cleanup.
 *
 * Use resources for subscriptions, caches, handles, or state that must be
 * released through Frond lifecycle operations instead of React unmounts.
 */
export function resourceSpec<TSpec extends NodeSpec<{ readonly result?: unknown }>>(
  spec: NodeSpecInput<TSpec>
): NodeDescriptor<TSpec> {
  return nodeSpecWithKind("resource", spec);
}

/**
 * Defines a facade node that presents a domain-facing API over dependencies.
 *
 * Facades keep product code narrow. They do not bypass graph dependency
 * readiness or operation serialization.
 */
export function facadeSpec<TSpec extends NodeSpec<{ readonly result?: unknown }>>(
  spec: NodeSpecInput<TSpec>
): NodeDescriptor<TSpec> {
  return nodeSpecWithKind("facade", spec);
}

function nodeSpecWithKind<TSpec extends NodeSpec<{ readonly result?: unknown }>>(
  kind: NodeKind,
  spec: NodeSpecInput<TSpec>
): NodeDescriptor<TSpec> {
  const descriptor: NodeDescriptor<TSpec> = {
    kind,
    tag: validateNodeTag(spec.tag),
    key: spec.key,
    dependencies: dependencyResolver(spec.dependencies),
    driver: spec.driver,
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

export function assertNodeSpec(value: unknown): asserts value is NodeSpecLike {
  if (
    (typeof value !== "function" && typeof value !== "object") ||
    value === null ||
    (value as { readonly spec?: unknown }).spec === undefined
  ) {
    throw new FrondNodeSpecError("Frond graph node request must use a Frond node spec.");
  }
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

function dependencyResolver<TSpec extends NodeSpec<{ readonly result?: unknown }>>(
  resolver: NodeSpecInput<TSpec>["dependencies"] | undefined
): NodeDescriptor<TSpec>["dependencies"] {
  if (resolver === undefined) {
    return () => ({}) as ReturnType<NodeDescriptor<TSpec>["dependencies"]>;
  }

  if (resolver[FROND_DEPENDENCIES_BRAND] !== true) {
    throw new FrondNodeSpecError(
      "Frond node dependencies must be created with Frond.dependencies."
    );
  }

  return resolver as unknown as NodeDescriptor<TSpec>["dependencies"];
}
