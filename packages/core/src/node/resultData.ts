import { isObservable } from "mobx";

type Shape = "object" | "array";
const frozen = new WeakSet<object>();
// Membership proves complete preparation; the value separately records whether
// the eligible subtree was physically frozen in development.
const committedSubtrees = new WeakMap<object, boolean>();
const needsInPlaceNotification = new WeakSet<object>();
// Draft copies of Frond-frozen containers: built by slice or spread and written
// only through the draft's set and delete traps, so every property is plain data.
const draftCopies = new WeakSet<object>();
// Deeper than any realistic result, well inside the call stack.
export const maxResultDepth = 1000;

export function isFrondFrozen(value: object): boolean {
  return frozen.has(value);
}

export function isFullyFrozen(value: unknown): boolean {
  return typeof value === "object" && value !== null && committedSubtrees.has(value);
}

export function isDevelopmentFrozen(value: unknown): boolean {
  return typeof value === "object" && value !== null && committedSubtrees.get(value) === true;
}

/** Fresh acquire staging can be mutable until it embeds committed plain data. */
export function containsCommittedPlainData(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (frozen.has(value)) return true;
  return containsCommittedContainer(value, new Map(), 0);
}

function containsCommittedContainer(
  value: unknown,
  visited: Map<object, number>,
  depth: number
): boolean {
  if (typeof value !== "object" || value === null || depth >= maxResultDepth) return false;
  if (frozen.has(value)) return true;
  const previousDepth = visited.get(value);
  if (previousDepth !== undefined && previousDepth <= depth) return false;
  const properties = describePlainResult(value);
  if (properties === undefined) return false;
  // A shallower revisit may reach data that a previous depth-limited walk cut.
  visited.set(value, depth);
  for (let index = 0; index < properties.keys.length; index += 1) {
    const key = properties.keys[index];
    if (
      typeof key !== "string" ||
      (properties.shape === "array" &&
        (String(Number(key)) !== key || !(Number(key) >= 0 && Number(key) < 4_294_967_295)))
    )
      continue;
    if (containsCommittedContainer(properties.descriptors[index]?.value, visited, depth + 1))
      return true;
  }
  return false;
}

export function markCommittedFrozen(
  value: object,
  complete: boolean,
  notifyInPlace: boolean,
  development: boolean
): void {
  frozen.add(value);
  if (complete) committedSubtrees.set(value, development || committedSubtrees.get(value) === true);
  if (notifyInPlace) needsInPlaceNotification.add(value);
  else needsInPlaceNotification.delete(value);
  draftCopies.delete(value);
}

export function markDraftCopy(value: object): void {
  draftCopies.add(value);
}

/**
 * Constant-time lookup for prepared snapshots. Observable boundaries notify
 * their own readers; other opaque objects need the shared-patch notification.
 */
export function resultNeedsInPlaceNotification(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (frozen.has(value) ? needsInPlaceNotification.has(value) : !isObservable(value))
  );
}

// Plain snapshot eligibility. Equality additionally accepts null-prototype and
// author-frozen objects; only this narrower shape can be frozen or shared.
function containerShape(value: unknown): Shape | undefined {
  if (typeof value !== "object" || value === null || isObservable(value)) return undefined;
  if (!Object.isExtensible(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) return prototype === Array.prototype ? "array" : undefined;
  return prototype === Object.prototype ? "object" : undefined;
}

function plainProperty(key: PropertyKey, descriptor: PropertyDescriptor | undefined): boolean {
  if (descriptor === undefined || !("value" in descriptor)) return false;
  if (typeof key === "symbol") return true;
  return (
    key !== "__proto__" &&
    descriptor.enumerable === true &&
    descriptor.writable === true &&
    descriptor.configurable === true
  );
}

export function plainShape(value: unknown): Shape | undefined {
  if (typeof value === "object" && value !== null && frozen.has(value))
    return Array.isArray(value) ? "array" : "object";
  const shape = containerShape(value);
  if (shape === undefined || draftCopies.has(value as object)) return shape;
  for (const key of Reflect.ownKeys(value as object)) {
    if (shape === "array" && key === "length") continue;
    if (!plainProperty(key, Object.getOwnPropertyDescriptor(value, key))) return undefined;
  }
  return shape;
}

/** Capture each candidate descriptor once for validation and commit comparison. */
export function describePlainResult(value: unknown):
  | {
      readonly shape: Shape;
      readonly keys: PropertyKey[];
      readonly descriptors: PropertyDescriptor[];
    }
  | undefined {
  const frondFrozen = typeof value === "object" && value !== null && frozen.has(value);
  const shape = frondFrozen ? (Array.isArray(value) ? "array" : "object") : containerShape(value);
  if (shape === undefined) return undefined;
  const keys = Reflect.ownKeys(value as object);
  const descriptors: PropertyDescriptor[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      (!frondFrozen && !(shape === "array" && key === "length") && !plainProperty(key, descriptor))
    )
      return undefined;
    descriptors.push(descriptor);
  }
  return { shape, keys, descriptors };
}
