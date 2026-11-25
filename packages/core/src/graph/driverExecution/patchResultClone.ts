import { isObservable } from "mobx";
import type { ResultPatchOptions } from "../../driver/types";
import { isFrondFrozen } from "../../node/resultData";
import type { GraphNodeCell } from "../cell/cellModel";
import { GraphInvariantViolation } from "../types";

export function clonePatchableResult(
  value: unknown,
  options: ResultPatchOptions | undefined,
  context: GraphNodeCell
): unknown {
  // MobX observable objects masquerade as plain objects (the dynamic proxy
  // reports Object.prototype) while every own property forwards into the
  // shared `$mobx` administration: a descriptor-copied "clone" is either a
  // write-through alias (a failed operation leaks its staged writes into
  // committed state) or a lying pseudo-observable carrying a foreign `$mobx`
  // slot. They take the documented non-plain contract instead — authors pick
  // staging semantics through `resultPatch.nonPlainClone`, and without it the
  // patch fails loudly. Observable arrays also take this path before array cloning.
  if (typeof value === "object" && value !== null && isObservable(value)) {
    return cloneNonPlainResult(value, options, context);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => clonePatchableResult(entry, options, context));
  }

  if (isPlainObject(value)) {
    const fastClone = clonePlainDataObject(value, options, context);

    if (fastClone !== undefined) {
      return fastClone;
    }

    // Copy EVERY own property — string and symbol keys, enumerable or not —
    // and keep the original prototype (plain objects may be null-prototype).
    // Enumerable string-keyed properties are patchable data and are staged by
    // VALUE snapshot: data values are cloned recursively and accessors are
    // evaluated into writable data slots, matching the historical
    // staging-isolation semantics — a staged write must never travel through
    // an original setter into committed state. Everything else (symbol-keyed
    // slots such as the result envelope's internal, non-enumerable
    // properties) is carried by reference with its original descriptor: those
    // are identity-bearing internals, not patchable data, and cloning them
    // would break or reject non-plain values like sockets and
    // AbortControllers.
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;

    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];

      if (descriptor === undefined || typeof key !== "string" || descriptor.enumerable !== true) {
        continue;
      }

      if ("value" in descriptor) {
        descriptor.value = clonePatchableResult(descriptor.value, options, context);
        if (isFrondFrozen(value)) {
          descriptor.writable = true;
          descriptor.configurable = true;
        }
        continue;
      }

      descriptors[key] = {
        value: clonePatchableResult(descriptor.get?.call(value), options, context),
        writable: true,
        enumerable: true,
        configurable: true,
      };
    }

    return Object.create(Object.getPrototypeOf(value), descriptors);
  }

  if (typeof value === "object" && value !== null) {
    return cloneNonPlainResult(value, options, context);
  }

  return value;
}

// Fast path for the common shape — an `Object.prototype` object whose own
// properties are enumerable string-keyed data (JSON-decoded payloads), either
// mutable or frozen by Frond. Equivalent to the descriptor copy for that
// shape: every slot holds the recursive clone, with mutable data descriptors.
// Avoids `getOwnPropertyDescriptors` + `Object.create(proto, descriptors)`,
// which dominate patch cost on Hermes. Returns `undefined` for any other shape.
function clonePlainDataObject(
  value: Record<string, unknown>,
  options: ResultPatchOptions | undefined,
  context: GraphNodeCell
): Record<string, unknown> | undefined {
  // An own `__proto__` key (JSON.parse makes one) would hit the prototype
  // setter on `clone[key] = …`; the descriptor path below defines it instead.
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    (!isFrondFrozen(value) && !Object.isExtensible(value)) ||
    Object.prototype.hasOwnProperty.call(value, "__proto__")
  ) {
    return undefined;
  }

  const keys = Object.keys(value);

  if (
    Object.getOwnPropertyNames(value).length !== keys.length ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return undefined;
  }

  if (!isFrondFrozen(value)) {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor?.writable !== true || descriptor.configurable !== true) {
        return undefined;
      }
    }
  }

  const clone: Record<string, unknown> = {};

  for (const key of keys) {
    clone[key] = clonePatchableResult(value[key], options, context);
  }

  return clone;
}

function cloneNonPlainResult(
  value: object,
  options: ResultPatchOptions | undefined,
  context: GraphNodeCell
): unknown {
  const nonPlainClone = options?.nonPlainClone;

  if (nonPlainClone === "share") {
    return value;
  }

  if (typeof nonPlainClone === "function") {
    return nonPlainClone(value);
  }

  throw new GraphInvariantViolation({
    nodeId: context.nodeId,
    tag: context.tag,
    invariant: "driver patchResult requires resultPatch.nonPlainClone for non-plain result values",
    cause: { constructorName: value.constructor?.name },
  });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}
