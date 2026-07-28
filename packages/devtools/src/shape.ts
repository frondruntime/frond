import { describeError } from "./cause.ts";
import { type ShapeDescriptor, UNREADABLE } from "./descriptors.ts";

const MAX_STRING_LENGTH = 256;
const MAX_KEYS = 32;
const MAX_DEPTH = 3;

/**
 * Reduces a value to something JSON-safe that cannot carry user data.
 *
 * Small primitives pass through, because in a runtime event they are ids, tags,
 * timestamps, and flags — the entire signal. Anything structured becomes a
 * descriptor: a node result or an action input is exactly the kind of value
 * that must not leave the process, and it is always an object or an array.
 *
 * ## The shape vocabulary
 *
 * One line per value, in a syntax that says what it is without a legend:
 *
 * ```text
 * {}                    a plain object, no own keys
 * {id,name,total}       a plain object with those keys, in order
 * {id,name,…}           …and more keys than {@link MAX_KEYS}
 * Wired{_tag,run}       the same object, discriminated: its `_tag` is "Wired"
 * AccountModel{?}       a class instance — the type, and no claim about fields
 * string[42]            an array of 42, named by its first element
 * {id,name}[3]          the same, where that element is an object
 * unknown[0]            an empty array: nothing to name it by
 * Map(3) / Set(3)       collections, by size
 * function / symbol / bigint    values with no JSON form
 * {…} / […]             the depth bound stopped the walk here
 * ```
 *
 * Strings rather than the `{_: "object", keys, truncated}` objects this used to
 * emit, and the reason is the reader rather than the wire: this feed is read by
 * an agent through MCP, where each descriptor arrived as several lines of
 * pretty-printed JSON to say one thing about one field. A node result rendered
 * as forty lines that contain no data is worse than one rendered as `{id,name}`.
 *
 * Lossless, which is the part that makes it safe: a shape descriptor is only
 * ever produced once the policy has decided the value itself is not crossing, so
 * there is nothing behind it that a richer encoding could have expanded to.
 *
 * The residual ambiguity is named rather than defended: a short app string that
 * happens to read `"function"` crosses verbatim at this policy and is
 * indistinguishable from the descriptor. Structured values are not ambiguous —
 * none of them cross — and paying an object per field to fix a collision with a
 * literal `"function"` is the wrong trade.
 */
export function describeShape(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  switch (typeof value) {
    case "boolean":
    case "number": {
      return value;
    }
    case "bigint":
    case "function":
    case "symbol": {
      return typeof value;
    }
    case "string": {
      // The one descriptor that stays an object at this policy, because it is
      // the one carrying content: `head` is app data, and a reader has to be
      // able to tell it from a string that crossed whole.
      return value.length <= MAX_STRING_LENGTH
        ? value
        : ({
            _: "string",
            length: value.length,
            head: value.slice(0, MAX_STRING_LENGTH),
          } satisfies ShapeDescriptor);
    }
    default: {
      return describeStructure(value, depth);
    }
  }
}

/** See {@link UNREADABLE} for why this cannot be allowed to throw. */
function describeStructure(value: object, depth: number): unknown {
  try {
    return describeStructureUnguarded(value, depth);
  } catch {
    return UNREADABLE;
  }
}

function describeStructureUnguarded(value: object, depth: number): unknown {
  // Before the depth check: a failure nested past the limit is still the reason
  // the event exists, and "an object, elided" is not worth the bytes it saves.
  if (value instanceof Error) {
    return describeError(value, "shape");
  }

  if (depth >= MAX_DEPTH) {
    return Array.isArray(value) ? "[…]" : "{…}";
  }

  if (Array.isArray(value)) {
    const first = value[0];

    // Named by its first element rather than by every one of them: a
    // homogeneous array is the common case and the first entry settles it, and
    // a heterogeneous one is not summarizable at any length worth spending.
    return `${first === undefined ? "unknown" : shapeName(first, depth + 1)}[${value.length}]`;
  }

  if (value instanceof Map) {
    return `Map(${value.size})`;
  }

  if (value instanceof Set) {
    return `Set(${value.size})`;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  // Class instances are app domain objects by construction; the type name is as
  // far as this encoder is willing to go, and `{?}` says the fields exist rather
  // than letting a bare type name read as "it has none".
  if (prototype !== null && prototype !== Object.prototype) {
    return `${(value.constructor as { readonly name?: string } | undefined)?.name ?? "object"}{?}`;
  }

  const keys = Object.keys(value);
  const shown = keys.length > MAX_KEYS ? [...keys.slice(0, MAX_KEYS), "…"] : keys;
  // `_tag` is the one nested field that survives verbatim. A discriminant is
  // structure, not data — and a failure feed that says "an object with these
  // keys" instead of "GraphNodeAcquireFailed" is not worth reading.
  const tag = (value as { readonly _tag?: unknown })._tag;

  return `${typeof tag === "string" ? tag : ""}{${shown.join(",")}}`;
}

/**
 * What an array is an array of.
 *
 * Distinct from {@link describeShape} because that answers with the value where
 * it can — a number stays a number — and a position naming a type needs the
 * type. `typeof` supplies every primitive name; structured entries recurse, so
 * an array of objects reads `{id,name}[3]` and inherits the depth bound with it.
 */
function shapeName(value: unknown, depth: number): string {
  if (value === null) {
    return "null";
  }

  if (typeof value !== "object") {
    return typeof value;
  }

  const described = describeStructure(value, depth);

  // An `Error` element describes as a cause chain, which is an object. Its
  // descriptor names it `error`, so the array says the same.
  return typeof described === "string" ? described : "error";
}
