import { Key } from "@frondruntime/core";

const objectFingerprintIds = new WeakMap<object, number>();
const symbolFingerprintIds = new Map<symbol, number>();

let nextFingerprintId = 0;

export function getReactArgsFingerprint(value: unknown): string {
  try {
    return `canonical:${Key.canonicalKey(value)}`;
  } catch {
    // React accepts opaque args for memo suppression even when they are not
    // valid graph keys. Runtime identity still belongs to canonical node ids.
  }

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  // Primitive types produce a deterministic string directly; reference types
  // (objects, functions) and symbols get an opaque per-identity id via a
  // WeakMap / Map so the fingerprint is stable across renders.
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${String(value)}`;
  if (typeof value === "boolean") return `boolean:${value ? "true" : "false"}`;
  if (typeof value === "bigint") return `bigint:${String(value)}`;
  if (typeof value === "symbol") return symbolFingerprint(value);
  if (typeof value === "object" || typeof value === "function")
    return objectFingerprint(value as object);

  return `unknown:${typeof value}`;
}

function objectFingerprint(value: object): string {
  const existingId = objectFingerprintIds.get(value);
  if (existingId !== undefined) {
    return `ref:${existingId}`;
  }

  const nextId = allocateFingerprintId();
  objectFingerprintIds.set(value, nextId);
  return `ref:${nextId}`;
}

function symbolFingerprint(value: symbol): string {
  const existingId = symbolFingerprintIds.get(value);
  if (existingId !== undefined) {
    return `symbol:${existingId}`;
  }

  const nextId = allocateFingerprintId();
  symbolFingerprintIds.set(value, nextId);
  return `symbol:${nextId}`;
}

function allocateFingerprintId(): number {
  nextFingerprintId += 1;

  return nextFingerprintId;
}
