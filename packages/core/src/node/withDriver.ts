import type { Driver, DriverMode } from "../driver/types";
import type { NodeBase } from "./runtime";
import type {
  NodeDescriptor,
  NodeKind,
  NodeSpec,
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecDeclaredDeps,
  NodeSpecInstance,
  NodeSpecKey,
  NodeSpecLike,
  NodeSpecMode,
  NodeSpecResult,
  NodeTag,
  ResolvedDeps,
} from "./types";
import { FROND_NODE_SPEC_BRAND, FrondNodeSpecError } from "./types";

type AbstractConstructor = abstract new (...args: ReadonlyArray<never>) => object;

/**
 * The spec carrier of a `specWithDriver` override: every shape member is
 * recovered from the original node class, so the override is interchangeable
 * with the original everywhere the shape matters.
 */
export type SpecWithDriverSpec<TSpec extends NodeSpecLike> = NodeSpec<{
  readonly mode: NodeSpecMode<TSpec>;
  readonly args: NodeSpecArgs<TSpec>;
  readonly key: NodeSpecKey<TSpec>;
  readonly deps: NodeSpecDeclaredDeps<TSpec>;
  readonly result: NodeSpecResult<TSpec>;
  readonly actions: NodeSpecActions<TSpec>;
}>;

/**
 * The replacement driver accepted by `specWithDriver`: same args, deps,
 * result, and actions as the original spec, and a mode literal that must
 * agree with the original shape's declared mode (the same must-agree
 * machinery as `nodeSpec.fromDriver`).
 */
export type SpecWithDriverReplacement<
  TSpec extends NodeSpecLike,
  TMode extends DriverMode = NodeSpecMode<TSpec>,
> = Driver<
  NodeBase<SpecWithDriverSpec<TSpec>>,
  NodeSpecArgs<TSpec>,
  ResolvedDeps<NodeSpecDeclaredDeps<TSpec>>,
  NodeSpecResult<TSpec>,
  NodeSpecActions<TSpec>,
  TMode
>;

/**
 * The class returned by `specWithDriver`: constructs the original node type
 * (instances remain `instanceof` the original class) and carries a descriptor
 * whose shape and mode match the original's, so the override is assignable
 * wherever the original class is expected. The construct signature mirrors
 * the original's abstractness: an override of a concrete node class is
 * concrete (parity with authored node classes), and an override of an
 * abstract original stays abstract, so `new Override()` is rejected where
 * `new Original()` would be. Either way, direct construction throws
 * `FrondNodeConstructionUnavailable` at runtime outside graph readiness, and
 * abstract members of the original remain unimplemented on the override.
 */
export type SpecWithDriverClass<
  TSpec extends NodeSpecLike,
  TMode extends DriverMode = NodeSpecMode<TSpec>,
> = (TSpec extends new (
  ...args: ReadonlyArray<never>
) => object
  ? new (
      ...args: ReadonlyArray<never>
    ) => NodeSpecInstance<TSpec>
  : abstract new (
      ...args: ReadonlyArray<never>
    ) => NodeSpecInstance<TSpec>) & {
  readonly prototype: NodeSpecInstance<TSpec>;
  readonly spec: NodeDescriptor<SpecWithDriverSpec<TSpec>, TMode>;
};

/**
 * Creates a production spec override that swaps ONLY the driver.
 *
 * Identity is preserved: the override keeps the original tag, key, kind,
 * dependency resolver (copied directly, deps stay wired), and class prototype
 * (`instanceof Original` keeps working). Pass it to
 * `createRuntime({ specOverrides: [{ from: Original, to: override }] })` to
 * boot the same node with the replacement driver.
 *
 * The replacement driver's mode literal must agree with the original spec
 * shape's declared mode, at the type level and at runtime.
 *
 * Contrast with the testing entrypoint's `mockSpec`: `specWithDriver` is the
 * production composition and keeps dependencies; `mockSpec` is test isolation
 * and severs them.
 *
 * This is the sanctioned interim for host-boundary injection — host callbacks
 * and other non-canonical inputs that must reach a driver travel through a
 * replacement driver built where those inputs are in scope — until the
 * runtime-services proposal lands.
 */
export function specWithDriver<
  TSpec extends NodeSpecLike,
  TMode extends NodeSpecMode<TSpec> = NodeSpecMode<TSpec>,
>(
  original: TSpec,
  driver: SpecWithDriverReplacement<TSpec, TMode>
): SpecWithDriverClass<TSpec, TMode> {
  const descriptor = readNodeDescriptor(original);
  const replacement = readReplacementDriver(driver);

  if (replacement.mode !== descriptor.driver.mode) {
    throw new FrondNodeSpecError(
      `Frond specWithDriver replacement driver mode "${String(replacement.mode)}" must agree ` +
        `with the original spec's driver mode "${String(descriptor.driver.mode)}".`
    );
  }

  const overrideDescriptor = {
    kind: descriptor.kind,
    tag: descriptor.tag,
    key: descriptor.key,
    // Copied directly: the resolver already carries the dependencies(...)
    // brand, so the override resolves the exact same graph topology.
    dependencies: descriptor.dependencies,
    driver,
  };

  Object.defineProperty(overrideDescriptor, FROND_NODE_SPEC_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  abstract class SpecWithDriverOverride extends (original as unknown as AbstractConstructor) {
    static readonly spec = overrideDescriptor;
  }

  return SpecWithDriverOverride as unknown as SpecWithDriverClass<TSpec, TMode>;
}

type RuntimeNodeDescriptor = {
  readonly kind: NodeKind;
  readonly tag: NodeTag;
  readonly key: (args: unknown) => unknown;
  readonly dependencies: (args: unknown) => object;
  readonly driver: { readonly mode: DriverMode };
};

function readNodeDescriptor(original: unknown): RuntimeNodeDescriptor {
  const descriptor =
    (typeof original === "function" || (typeof original === "object" && original !== null)) &&
    "spec" in original
      ? (original as { readonly spec: unknown }).spec
      : undefined;

  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    (descriptor as { readonly [FROND_NODE_SPEC_BRAND]?: unknown })[FROND_NODE_SPEC_BRAND] !== true
  ) {
    throw new FrondNodeSpecError(
      "Frond specWithDriver expects a node spec class with a static branded spec."
    );
  }

  return descriptor as RuntimeNodeDescriptor;
}

function readReplacementDriver(driver: unknown): { readonly mode: DriverMode } {
  if (
    typeof driver !== "object" ||
    driver === null ||
    (driver as { readonly _tag?: unknown })._tag !== "NormalizedDriver"
  ) {
    throw new FrondNodeSpecError(
      "Frond specWithDriver replacement driver must be built with Driver.Async or Driver.Effect."
    );
  }

  return driver as { readonly mode: DriverMode };
}
