import { isObservable } from "mobx";
import {
  plainDataEqual,
  sameDataDescriptor,
  samePlainShape,
} from "../graph/resultValidity/plainDataEqual";
import {
  describePlainResult,
  isDevelopmentFrozen,
  isFrondFrozen,
  isFullyFrozen,
  isMutableReference,
  markCommittedFrozen,
  maxResultDepth,
  resultNeedsInPlaceNotification,
} from "./resultData";

type Container = Record<PropertyKey, unknown>;
type Comparison = boolean | undefined;
// Committed rows are read-only in both modes. Cache their discrimination once
// so resolving a lone edited row never enumerates untouched row containers.
interface RowFingerprint {
  readonly value: string;
  readonly keyCount: number;
}
const rowFingerprints = new WeakMap<object, RowFingerprint>();
interface Prepared {
  readonly value: unknown;
  // undefined requires the complete comparator (opaque slots, cycles, depth cuts).
  readonly equal: Comparison;
  readonly complete: boolean;
  readonly shareable: boolean;
  readonly notifyInPlace: boolean;
}

/** Normalize, share, and optionally freeze in one post-order walk over candidate data. */
export function prepareCommittedResult(
  candidate: unknown,
  previous: unknown,
  retainEqual: boolean,
  development: boolean
): unknown {
  const prepared = prepare(candidate, previous, new Set(), retainEqual, development);
  if (
    retainEqual &&
    (prepared.equal === true ||
      (prepared.equal === undefined && plainDataEqual(previous, prepared.value)))
  ) {
    // The complete comparator may retain a cyclic or depth-limited root.
    // Ownership alone cannot certify that a production snapshot was frozen.
    if (
      development &&
      typeof previous === "object" &&
      previous !== null &&
      isFrondFrozen(previous) &&
      !isDevelopmentFrozen(previous)
    )
      return prepare(previous, undefined, new Set(), false, true).value;
    return previous;
  }
  return prepared.value;
}

function mergeEqual(left: Comparison, right: Comparison): Comparison {
  if (left === false || right === false) return false;
  return left === undefined || right === undefined ? undefined : true;
}

function identityEqual(left: unknown, right: unknown): Comparison {
  if (Object.is(left, right)) return true;
  return typeof left === "object" && left !== null && typeof right === "object" && right !== null
    ? undefined
    : false;
}

function previousDescriptor(
  value: object | undefined,
  key: PropertyKey
): PropertyDescriptor | undefined {
  try {
    return value === undefined ? undefined : Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function comparable(
  previous: unknown,
  candidate: object,
  development: boolean
): previous is object {
  if (typeof previous !== "object" || previous === null) return false;
  try {
    return samePlainShape(previous, candidate, development, true);
  } catch {
    return false;
  }
}

function copyContainer(value: Container): Container {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) continue;
    descriptor.writable = true;
    if (!(Array.isArray(value) && key === "length")) descriptor.configurable = true;
  }
  return Object.defineProperties(Array.isArray(value) ? [] : {}, descriptors) as Container;
}

function prepare(
  value: unknown,
  previous: unknown,
  path: Set<object>,
  reuse: boolean,
  development: boolean
): Prepared {
  if (Object.is(value, previous) && reusable(value, development))
    return {
      value,
      equal: true,
      complete: true,
      shareable: true,
      notifyInPlace: resultNeedsInPlaceNotification(value),
    };
  const properties = describePlainResult(value);
  if (properties === undefined)
    return {
      value,
      equal: identityEqual(previous, value),
      complete: true,
      shareable: Object.is(previous, value),
      notifyInPlace: resultNeedsInPlaceNotification(value),
    };
  const candidate = value as Container;
  // The ancestor's walk already accounts for every object reachable through
  // a back edge. A cycle alone does not imply a shared mutable model.
  if (path.has(candidate))
    return { value, equal: undefined, complete: false, shareable: false, notifyInPlace: false };
  if (path.size >= maxResultDepth)
    return { value, equal: undefined, complete: false, shareable: false, notifyInPlace: true };
  const matches = comparable(previous, candidate, development);
  const before = matches ? (previous as Container) : undefined;
  const { shape, keys, descriptors } = properties;
  let equal: Comparison = matches;
  if (before !== undefined) {
    try {
      equal =
        (rowFingerprints.get(before)?.keyCount ?? Reflect.ownKeys(before).length) === keys.length;
    } catch {
      equal = false;
    }
  }
  let shareable = equal;
  let complete = true;
  let notifyInPlace = false;
  let output = candidate;
  const assign = (key: PropertyKey, writable: boolean | undefined, entry: unknown) => {
    // Fresh plain driver data is committed here; reuse its allocation.
    // A Frond-committed container requires copy-on-write. Author-frozen data
    // never reaches this branch because plainShape treats it as opaque.
    if (output === candidate && (isFrondFrozen(candidate) || writable !== true))
      output = copyContainer(candidate);
    output[key] = entry;
  };
  const rows =
    shape === "array" && Array.isArray(before)
      ? new MovedRows(before, (candidate as unknown as ReadonlyArray<unknown>).length, development)
      : undefined;
  path.add(candidate);
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) continue;
      const descriptor = descriptors[index];
      const old = previousDescriptor(before, key);
      const descriptorsEqual = sameDataDescriptor(old, descriptor, development);
      if (!descriptorsEqual) {
        equal = false;
        shareable = false;
      }
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const plainSlot =
        typeof key === "string" &&
        (shape === "object" ||
          (key !== "length" &&
            String(Number(key)) === key &&
            Number(key) >= 0 &&
            Number(key) < 4_294_967_295));
      if (!plainSlot) {
        // Symbol payloads and custom array slots are retained without copying.
        if (isMutableReference(descriptor.value) && !isObservable(descriptor.value))
          notifyInPlace = true;
        if (descriptorsEqual)
          equal = mergeEqual(equal, identityEqual(old?.value, descriptor.value));
        if (!Object.is(old?.value, descriptor.value)) shareable = false;
        continue;
      }
      // Descriptor values preserve equality semantics without invoking accessors.
      const entry: unknown = descriptor.value;
      if (typeof entry !== "object" || entry === null) {
        // A callable is opaque: retained by identity, it can change in place.
        if (typeof entry === "function" && !isObservable(entry)) notifyInPlace = true;
        const same = Object.is(entry, old?.value);
        if (descriptorsEqual) equal = mergeEqual(equal, same);
        if (!same) shareable = false;
        continue;
      }
      const child = prepare(entry, old?.value, path, true, development);
      if (shape === "array" && rows === undefined) rowFingerprint(child.value);
      if (descriptorsEqual) equal = mergeEqual(equal, child.equal);
      if (!child.shareable) shareable = false;
      if (!child.complete) complete = false;
      if (child.notifyInPlace) notifyInPlace = true;
      if (!Object.is(entry, child.value)) assign(key, descriptor.writable, child.value);
      // Equality above stays positional; a moved row only swaps in the old
      // object it equals, so the flags merged from `child` still hold.
      if (rows !== undefined && !child.shareable)
        for (const moved of rows.missed(Number(key), child.value, descriptor.writable, path))
          assign(moved.key, moved.writable, moved.value);
    }
    const remaining = rows?.flush(path);
    if (remaining !== undefined) assign(remaining.key, remaining.writable, remaining.value);
    if (reuse && shareable && complete && reusable(previous, development))
      return {
        value: previous,
        equal,
        complete: true,
        shareable: true,
        notifyInPlace: resultNeedsInPlaceNotification(previous),
      };
    if (development && (!isFrondFrozen(output) || !Object.isFrozen(output))) Object.freeze(output);
    markCommittedFrozen(output, complete, notifyInPlace, development);
    return { value: output, equal, complete, shareable, notifyInPlace };
  } finally {
    path.delete(candidate);
  }
}

function reusable(value: unknown, development: boolean): boolean {
  return development ? isDevelopmentFrozen(value) : isFullyFrozen(value);
}

interface MovedRow {
  readonly key: string;
  readonly writable: boolean | undefined;
  readonly value: unknown;
}

/**
 * Finds, for an array entry its positional match missed, an old entry it
 * equals elsewhere in the previous array, so a prepend, removal, or reorder
 * keeps the old row objects. The index over the old entries is built on the
 * second miss, or the first when the length changed. A single miss is
 * resolved at the end of the array walk.
 */
class MovedRows {
  private index: Map<string, Array<number>> | undefined;
  private firstMiss:
    | {
        readonly position: number;
        readonly writable: boolean | undefined;
        readonly value: unknown;
        readonly fingerprint: RowFingerprint;
      }
    | undefined;
  private readonly lengthChanged: boolean;

  constructor(
    private readonly before: ReadonlyArray<unknown>,
    length: number,
    private readonly development: boolean
  ) {
    this.lengthChanged = before.length !== length;
  }

  missed(
    position: number,
    value: unknown,
    writable: boolean | undefined,
    path: Set<object>
  ): ReadonlyArray<MovedRow> {
    const fingerprint = rowFingerprint(value, undefined, false);
    if (fingerprint === undefined) return [];
    if (this.index === undefined) {
      if (!this.lengthChanged && this.firstMiss === undefined) {
        this.firstMiss = { position, writable, value, fingerprint };
        return [];
      }
      this.index = this.buildIndex();
    }
    const found: Array<MovedRow> = [];
    const first = this.flush(path);
    if (first !== undefined) found.push(first);
    const match = this.match(position, value, fingerprint.value, path);
    if (match !== undefined) found.push({ key: String(position), writable, value: match });
    else rememberRowFingerprint(value, fingerprint);
    return found;
  }

  flush(path: Set<object>): MovedRow | undefined {
    const first = this.firstMiss;
    if (first === undefined) return undefined;
    this.firstMiss = undefined;
    this.index ??= this.buildIndex();
    const match = this.match(first.position, first.value, first.fingerprint.value, path);
    if (match === undefined) rememberRowFingerprint(first.value, first.fingerprint);
    return match === undefined
      ? undefined
      : { key: String(first.position), writable: first.writable, value: match };
  }

  private match(position: number, value: unknown, fingerprint: string, path: Set<object>): unknown {
    const candidates = this.index?.get(fingerprint);
    if (candidates === undefined) return undefined;
    for (const index of candidates) {
      if (index === position) continue;
      const old = previousDescriptor(this.before, String(index))?.value;
      if (sameCommittedRow(value, old, this.development, path.size)) return old;
    }
    return undefined;
  }

  private buildIndex(): Map<string, Array<number>> {
    const index = new Map<string, Array<number>>();
    for (let position = 0; position < this.before.length; position += 1) {
      const fingerprint = rowFingerprint(previousDescriptor(this.before, String(position))?.value);
      if (fingerprint === undefined) continue;
      const positions = index.get(fingerprint.value);
      if (positions === undefined) index.set(fingerprint.value, [position]);
      else positions.push(position);
    }
    return index;
  }
}

/** Both rows are prepared already; compare without preparing or freezing them again. */
function sameCommittedRow(
  value: unknown,
  previous: unknown,
  development: boolean,
  depth: number
): boolean {
  if (Object.is(value, previous)) return true;
  if (!reusable(value, development) || !reusable(previous, development) || depth >= maxResultDepth)
    return false;
  const candidate = value as Container;
  if (!comparable(previous, candidate, development)) return false;
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== (rowFingerprints.get(previous)?.keyCount ?? Reflect.ownKeys(previous).length))
    return false;
  const array = Array.isArray(candidate);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    const old = previousDescriptor(previous, key);
    if (!sameDataDescriptor(old, descriptor)) return false;
    const plainSlot =
      typeof key === "string" &&
      (!array || (String(Number(key)) === key && Number(key) >= 0 && Number(key) < 4_294_967_295));
    if (plainSlot) {
      if (!sameCommittedRow(descriptor?.value, old?.value, development, depth + 1)) return false;
    } else if (!Object.is(descriptor?.value, old?.value)) {
      return false;
    }
  }
  return true;
}

/**
 * Include nested plain values so ordinary nested rows do not collapse into
 * one quadratic collision bucket. Opaque boundaries and depth cuts can still
 * collide; every candidate in a matching bucket is compared in full.
 */
function rowFingerprint(
  value: unknown,
  path?: Set<object>,
  cache = true
): RowFingerprint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const cached = rowFingerprints.get(value);
  if (cached !== undefined) return cached;
  if (path !== undefined && (path.has(value) || path.size >= maxResultDepth)) return undefined;
  const properties = describePlainResult(value);
  if (properties === undefined) return undefined;
  const parts: Array<string> = [];
  for (let index = 0; index < properties.keys.length; index += 1) {
    const key = properties.keys[index];
    const descriptor = properties.descriptors[index];
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)) continue;
    const field: unknown = descriptor.value;
    if (typeof field === "object" && field !== null) {
      path ??= new Set();
      path.add(value);
      const nested = rowFingerprint(field, path, cache);
      path.delete(value);
      parts.push(`${key}\u0001object\u0001${nested?.value ?? "opaque"}`);
    } else if (typeof field === "function") {
      // Never run a function's coercion hooks; candidates are compared in full.
      parts.push(`${key}\u0001function`);
    } else {
      parts.push(`${key}\u0001${typeof field}\u0001${String(field)}`);
    }
  }
  const fingerprint = { value: parts.sort().join("\u0000"), keyCount: properties.keys.length };
  if (cache) rememberRowFingerprint(value, fingerprint);
  return fingerprint;
}

function rememberRowFingerprint(value: unknown, fingerprint: RowFingerprint): void {
  if (isFullyFrozen(value)) rowFingerprints.set(value as object, fingerprint);
}
