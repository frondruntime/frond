import { KeyNonFiniteNumberError, KeyTooLongError, KeyUnsupportedJsonValueError } from "./errors";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export type KeyInput = JsonValue;

export const MAX_CANONICAL_KEY_LENGTH = 2048;

/**
 * Canonicalizes a graph key and enforces the bounded identity contract.
 *
 * Keys and args share the same JSON-shaped input rules. Only keys are capped
 * at {@link MAX_CANONICAL_KEY_LENGTH}; use {@link canonicalArgs} for raw args.
 */
export function canonicalKey(keyInput: unknown): string {
  const canonical = canonicalizeKeyInput(keyInput);

  assertCanonicalLength(canonical);

  return canonical;
}

/**
 * Validates and canonicalizes raw node args without applying the key length cap.
 *
 * Args may be arbitrarily large, but must remain JSON-shaped. This can throw
 * {@link KeyNonFiniteNumberError} or {@link KeyUnsupportedJsonValueError}; it
 * never throws {@link KeyTooLongError}.
 */
export function canonicalArgs(args: unknown): string {
  return canonicalizeKeyInput(args);
}

function canonicalizeKeyInput(value: unknown): string {
  return `v1:${encodeKeyValue(value, "$")}`;
}

// Single pass: validate and stringify together so each value (and each object's
// keys) is visited and sorted exactly once. Throws the same typed errors at the
// same paths as a separate validate-then-stringify pass.
function encodeKeyValue(value: unknown, path: string): string {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    assertFiniteNumber(value, path);

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return encodeArray(value, path);
  }

  if (isPlainObject(value)) {
    return encodeObject(value, path);
  }

  throw new KeyUnsupportedJsonValueError({
    _tag: "KeyUnsupportedJsonValueError",
    message: `Invalid key input at ${path}: only JSON-shaped values are supported.`,
    path,
  });
}

function isPlainObject(value: unknown): value is { readonly [key: string]: unknown } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function assertFiniteNumber(value: number, path: string): void {
  if (Number.isFinite(value)) {
    return;
  }

  throw new KeyNonFiniteNumberError({
    _tag: "KeyNonFiniteNumberError",
    message: `Invalid key input at ${path}: non-finite number.`,
    path,
    value,
  });
}

function encodeArray(value: ReadonlyArray<unknown>, path: string): string {
  const items: Array<string> = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = index in value ? value[index] : undefined;
    items.push(encodeKeyValue(item, `${path}[${index}]`));
  }

  return `[${items.join(",")}]`;
}

function encodeObject(value: { readonly [key: string]: unknown }, path: string): string {
  const body = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeKeyValue(value[key], `${path}.${key}`)}`)
    .join(",");

  return `{${body}}`;
}

function assertCanonicalLength(value: string): void {
  if (value.length <= MAX_CANONICAL_KEY_LENGTH) {
    return;
  }

  throw new KeyTooLongError({
    _tag: "KeyTooLongError",
    message: "Canonical key exceeded maximum size.",
    maxLength: MAX_CANONICAL_KEY_LENGTH,
    actualLength: value.length,
  });
}
