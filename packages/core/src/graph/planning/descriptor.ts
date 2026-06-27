import type { Driver } from "../../driver";
import {
  type DependenciesRecord,
  FROND_NODE_SPEC_BRAND,
  FrondNodeSpecError,
  type NodeKind,
} from "../../node";

export type NodeDescriptor = {
  readonly kind: NodeKind;
  readonly tag: string;
  readonly key: (args: unknown) => unknown;
  readonly dependencies: (args: unknown) => DependenciesRecord;
  readonly driver: Driver<object, unknown, object, unknown, object>;
};

export function getNodeDescriptor(spec: unknown): NodeDescriptor {
  if (!isFrondNodeSpec(spec)) {
    throw new FrondNodeSpecError(
      "Frond graph node request must use a Frond node spec with static spec."
    );
  }

  const descriptor = getDescriptorValue(spec);

  if (!isRecord(descriptor)) {
    throw new FrondNodeSpecError("Frond graph node request must use a Frond node spec.");
  }

  const { kind, tag, key, dependencies, driver } = descriptor;

  if (
    !isNodeKind(kind) ||
    typeof tag !== "string" ||
    typeof key !== "function" ||
    typeof dependencies !== "function" ||
    !isRecord(driver)
  ) {
    throw new FrondNodeSpecError("Frond node spec descriptor is malformed.");
  }

  return {
    kind,
    tag,
    key: key as (args: unknown) => unknown,
    dependencies: dependencies as (args: unknown) => DependenciesRecord,
    driver: driver as Driver<object, unknown, object, unknown, object>,
  };
}

// Checks whether `spec` is a *wrapper* (e.g. a NodeBase subclass with a static
// `.spec` property) containing a branded Frond node descriptor — not whether it
// is a branded descriptor itself. A raw descriptor passed directly returns false;
// callers must always wrap their descriptor in a `{ spec: ... }` container.
export function isFrondNodeSpec(spec: unknown): boolean {
  if (hasNodeSpecBrand(spec)) {
    return false;
  }

  const descriptor = getStaticSpecValue(spec);

  return hasNodeSpecBrand(descriptor);
}

function isNodeKind(value: unknown): value is NodeKind {
  return value === "node" || value === "service" || value === "resource" || value === "facade";
}

function getDescriptorValue(spec: unknown): unknown {
  return getStaticSpecValue(spec);
}

function getStaticSpecValue(spec: unknown): unknown {
  if ((typeof spec !== "object" && typeof spec !== "function") || spec === null) {
    return undefined;
  }

  const value = (spec as { readonly spec?: unknown }).spec;

  if (hasNodeSpecBrand(value)) {
    return value;
  }

  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (value as { readonly spec?: unknown }).spec !== undefined
  ) {
    return getStaticSpecValue(value);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasNodeSpecBrand(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [FROND_NODE_SPEC_BRAND]?: unknown })[FROND_NODE_SPEC_BRAND] === true
  );
}
