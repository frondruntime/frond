import { describeError } from "./cause.ts";
import { type ShapeDescriptor, UNREADABLE } from "./descriptors.ts";

/**
 * Bounds for `"full"`. Termination guards, not a byte budget.
 *
 * This encoder runs against a loopback socket, so bytes are close to free; what
 * these stop is a cycle the `seen` set cannot catch, a proxy that manufactures
 * keys on demand, or a linked list a few hundred thousand long — cases where the
 * walk would hang the observed app inside its own devtools. Set them where a
 * pathological structure trips them and a large-but-real one does not, and every
 * one of them announces itself in the output. A cap an agent cannot see is worse
 * than a low cap: it turns "there was more" into "that was all", which is the
 * one thing this feed must never say.
 */
const FULL_MAX_DEPTH = 24;
const FULL_MAX_STRING_LENGTH = 65536;
const FULL_MAX_ENTRIES = 4096;
/**
 * Total encoded values per record, across the whole tree.
 *
 * Counts values, not characters: one 64k string spends the same allowance as
 * `true`. So this bounds how long the walk runs, and only loosely bounds what it
 * produces — which is the right trade here, where the walk is the expensive half
 * and the wire is a socket to the same machine.
 */
export const FULL_MAX_NODES = 50000;

export type Budget = { remaining: number };

/**
 * Reduces a value to JSON-safe form while keeping its contents.
 *
 * The counterpart to `describeShape`, and the opposite default: where the shape
 * encoder asks "what can I say without revealing this", this one asks "what is
 * the least I can leave out".
 *
 * Which is also why it does not share that encoder's string vocabulary. Here the
 * values around a marker are real data, so a marker has to stay
 * distinguishable from one — hence `{_: "elided"}` rather than a word. There,
 * nothing structured is real, so there is nothing for a word to collide with.
 *
 * `seen` is the ancestor path, not every value visited. A value that appears
 * twice in a result — a shared config object, the same node referenced by two
 * dependents — is legitimately encoded twice; only a value containing *itself*
 * is a cycle. Tracking all visited values instead would silently blank out
 * shared structure and read as data loss.
 */
export function describeFull(
  value: unknown,
  depth: number,
  seen: Set<object>,
  budget: Budget
): unknown {
  if (budget.remaining <= 0) {
    return { _: "elided", by: "budget" } satisfies ShapeDescriptor;
  }

  budget.remaining -= 1;

  if (value === null || value === undefined) {
    return value ?? null;
  }

  switch (typeof value) {
    case "boolean":
    case "number": {
      return value;
    }
    // Not JSON-safe, and no rendering of them is more useful than saying what
    // they were.
    case "bigint": {
      return { _: "opaque", type: `bigint:${value.toString()}` } satisfies ShapeDescriptor;
    }
    case "function": {
      return {
        _: "opaque",
        type: `function:${(value as { readonly name?: string }).name || "anonymous"}`,
      } satisfies ShapeDescriptor;
    }
    case "symbol": {
      return { _: "opaque", type: value.toString() } satisfies ShapeDescriptor;
    }
    case "string": {
      return value.length <= FULL_MAX_STRING_LENGTH
        ? value
        : ({
            _: "string",
            length: value.length,
            head: value.slice(0, FULL_MAX_STRING_LENGTH),
          } satisfies ShapeDescriptor);
    }
    default: {
      return describeFullStructure(value as object, depth, seen, budget);
    }
  }
}

function describeFullStructure(
  value: object,
  depth: number,
  seen: Set<object>,
  budget: Budget
): unknown {
  try {
    return describeFullStructureUnguarded(value, depth, seen, budget);
  } catch {
    // See {@link UNREADABLE}. The `seen` set is left as this call found it: the
    // one place that adds to it deletes in a `finally`.
    return UNREADABLE;
  }
}

function describeFullStructureUnguarded(
  value: object,
  depth: number,
  seen: Set<object>,
  budget: Budget
): unknown {
  if (seen.has(value)) {
    return { _: "cycle" } satisfies ShapeDescriptor;
  }

  if (value instanceof Error) {
    const described = describeError(value, "full", {
      seen,
      encodeValue: (own) => describeFull(own, depth + 1, seen, budget),
    });

    // Charged against the record's allowance like any other subtree, so one
    // deeply-wrapped failure cannot spend the whole budget on itself.
    budget.remaining -= described.causes.length;

    return described;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= FULL_MAX_DEPTH) {
    return { _: "elided", by: "depth" } satisfies ShapeDescriptor;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const kept = value.slice(0, FULL_MAX_ENTRIES);
      const encoded: Array<unknown> = kept.map((entry) =>
        describeFull(entry, depth + 1, seen, budget)
      );

      if (value.length > FULL_MAX_ENTRIES) {
        encoded.push({
          _: "elided",
          by: "entries",
          length: value.length,
        } satisfies ShapeDescriptor);
      }

      return encoded;
    }

    if (value instanceof Map) {
      return {
        _: "map",
        entries: [...value.entries()]
          .slice(0, FULL_MAX_ENTRIES)
          .map(
            ([key, entry]) =>
              [
                describeFull(key, depth + 1, seen, budget),
                describeFull(entry, depth + 1, seen, budget),
              ] as const
          ),
        size: value.size,
      } satisfies ShapeDescriptor;
    }

    if (value instanceof Set) {
      return {
        _: "set",
        values: [...value.values()]
          .slice(0, FULL_MAX_ENTRIES)
          .map((entry) => describeFull(entry, depth + 1, seen, budget)),
        size: value.size,
      } satisfies ShapeDescriptor;
    }

    const out: Record<string, unknown> = {};

    // Own enumerable keys only. Walking the prototype chain would drag in
    // methods and framework internals, which is noise rather than visibility.
    const allKeys = Object.keys(value);
    const keys = allKeys.slice(0, FULL_MAX_ENTRIES);

    for (const key of keys) {
      out[key] = describeFull((value as Record<string, unknown>)[key], depth + 1, seen, budget);
    }

    // An array that gets truncated pushes a marker; an object has to carry one
    // as a key, and a silently short key list is the failure this whole encoder
    // is written against — it reads as "the object had 256 keys", which is a lie
    // the consumer has no way to detect.
    //
    // A real key named `_elided` loses to the marker. Preferred over a mangled
    // name: the collision is vanishingly rare, and a marker under a name nobody
    // reads is the same as no marker.
    if (allKeys.length > keys.length) {
      out["_elided"] = {
        _: "elided",
        by: "entries",
        length: allKeys.length,
      } satisfies ShapeDescriptor;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    // Class instances keep their type name alongside their fields: knowing a
    // value is a `HubServerResult` and not a bag of keys is most of what makes
    // a graph result readable.
    if (prototype !== null && prototype !== Object.prototype) {
      out["_type"] =
        (value.constructor as { readonly name?: string } | undefined)?.name ?? "object";
    }

    return out;
  } finally {
    seen.delete(value);
  }
}
