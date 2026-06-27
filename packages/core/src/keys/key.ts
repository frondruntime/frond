import { Match } from "effect";
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

export function canonicalKey(keyInput: unknown): string {
  const canonical = `v1:${encodeKeyValue(keyInput, "$")}`;

  assertCanonicalLength(canonical);

  return canonical;
}

type EncodeKeyValue =
  | { readonly _tag: "Undefined" }
  | { readonly _tag: "Null" }
  | { readonly _tag: "String"; readonly value: string }
  | { readonly _tag: "Boolean"; readonly value: boolean }
  | { readonly _tag: "Number"; readonly value: number }
  | { readonly _tag: "Array"; readonly value: ReadonlyArray<unknown> }
  | { readonly _tag: "Object"; readonly value: { readonly [key: string]: unknown } }
  | { readonly _tag: "Unsupported" };

function classifyKeyValue(value: unknown): EncodeKeyValue {
  return Match.value(value).pipe(
    Match.when(undefined, () => ({ _tag: "Undefined" }) as const),
    Match.when(null, () => ({ _tag: "Null" }) as const),
    Match.when(
      (candidate: unknown): candidate is string => typeof candidate === "string",
      (stringValue) => ({ _tag: "String", value: stringValue }) as const
    ),
    Match.when(
      (candidate: unknown): candidate is boolean => typeof candidate === "boolean",
      (booleanValue) => ({ _tag: "Boolean", value: booleanValue }) as const
    ),
    Match.when(
      (candidate: unknown): candidate is number => typeof candidate === "number",
      (numberValue) => ({ _tag: "Number", value: numberValue }) as const
    ),
    Match.when(
      (candidate: unknown): candidate is ReadonlyArray<unknown> => Array.isArray(candidate),
      (arrayValue) => ({ _tag: "Array", value: arrayValue }) as const
    ),
    Match.when(isPlainObject, (objectValue) => ({ _tag: "Object", value: objectValue }) as const),
    Match.orElse(() => ({ _tag: "Unsupported" }) as const)
  );
}

// Single pass: validate and stringify together so each value (and each object's
// keys) is visited and sorted exactly once. Throws the same typed errors at the
// same paths as a separate validate-then-stringify pass.
function encodeKeyValue(value: unknown, path: string): string {
  return Match.value(classifyKeyValue(value)).pipe(
    Match.tag("Undefined", () => "undefined"),
    Match.tag("Null", () => "null"),
    Match.tag("String", ({ value: stringValue }) => JSON.stringify(stringValue)),
    Match.tag("Boolean", ({ value: booleanValue }) => (booleanValue ? "true" : "false")),
    Match.tag("Number", ({ value: numberValue }) => {
      assertFiniteNumber(numberValue, path);

      return JSON.stringify(numberValue);
    }),
    Match.tag("Array", ({ value: arrayValue }) => encodeArray(arrayValue, path)),
    Match.tag("Object", ({ value: objectValue }) => encodeObject(objectValue, path)),
    Match.tag("Unsupported", () => {
      throw new KeyUnsupportedJsonValueError({
        _tag: "KeyUnsupportedJsonValueError",
        message: `Invalid key input at ${path}: only JSON-shaped values are supported.`,
        path,
      });
    }),
    Match.exhaustive
  );
}

function isPlainObject(value: unknown): value is { readonly [key: string]: unknown } {
  return Match.value(value).pipe(
    Match.when(
      (candidate: unknown): candidate is object =>
        typeof candidate === "object" && candidate !== null,
      (objectValue) => {
        const prototype = Object.getPrototypeOf(objectValue);

        return prototype === Object.prototype || prototype === null;
      }
    ),
    Match.orElse(() => false)
  );
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
