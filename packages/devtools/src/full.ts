import { describeError } from "./cause.ts";
import {
  describeNonFiniteNumber,
  type ShapeDescriptor,
  setField,
  typeName,
  UNREADABLE,
} from "./descriptors.ts";

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
    case "boolean": {
      return value;
    }
    // See `describeShape` for the finiteness test: one subtraction, so a finite
    // number takes the same path it always did.
    case "number": {
      return value - value === 0 ? value : describeNonFiniteNumber(value);
    }
    // Not JSON-safe, and no rendering of them is more useful than saying what
    // they were.
    case "bigint": {
      return { _: "opaque", type: `bigint:${value.toString()}` } satisfies ShapeDescriptor;
    }
    case "function": {
      return {
        _: "opaque",
        type: `function:${functionName(value)}`,
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
    // An invalid date throws here and reaches the guard around this walk as
    // unreadable. An override can instead return anything, and a non-string
    // fails the transport for the whole batch, so it reads the same way.
    const iso: unknown = value.toISOString();

    return typeof iso === "string" ? iso : UNREADABLE;
  }

  if (depth >= FULL_MAX_DEPTH) {
    return { _: "elided", by: "depth" } satisfies ShapeDescriptor;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const length = arrayLength(value);
      // `length` is read through the array's own getter, which a proxy can
      // answer with anything: a non-number or `NaN` reads as empty, and an
      // infinity as past the bound.
      const count =
        typeof length === "number" && length > 0
          ? Math.min(Math.floor(length), FULL_MAX_ENTRIES)
          : 0;
      const encoded: Array<unknown> = [];

      // Indexed, with each read guarded on its own: a hole reads as `undefined`
      // and goes out as `null`, where a hole left in place fails the transport
      // for the whole batch, and an entry whose read throws costs that entry
      // rather than every readable one beside it.
      for (let index = 0; index < count; index++) {
        let entry: unknown;

        try {
          entry = value[index];
        } catch {
          encoded.push(UNREADABLE);
          continue;
        }

        encoded.push(describeFull(entry, depth + 1, seen, budget));
      }

      if (typeof length === "number" && length > FULL_MAX_ENTRIES) {
        encoded.push(entriesCut(finiteNumber(length)));
      }

      return encoded;
    }

    // Read through the iterator protocol, as a spread reads them, with every
    // read that can run the app's code guarded on its own: `size`, each step,
    // its `done` and its `value`, and each half of a map's pair. A subclass can
    // override any of them, and a throw in one should not cost what the others
    // read. The walk of what a step held has guards of its own. The iterator is
    // taken outside the guards, because a value that cannot even give one up
    // has nothing readable at all.
    if (value instanceof Map) {
      const walk = readSteps(value.entries());
      const entries: Array<readonly [unknown, unknown]> = [];

      for (let index = 0; index < walk.values.length; index++) {
        const pair = walk.values[index];

        entries.push([
          describeStepValue(halfOf(pair, 0), depth, seen, budget),
          describeStepValue(halfOf(pair, 1), depth, seen, budget),
        ]);
      }

      const reported = collectionSize(value);
      const size = reported ?? entries.length;

      // Each marker is a pair, like every other entry, so a reader walking
      // pairs meets it where the entries stopped.
      switch (walk.end) {
        case "broken": {
          entries.push([UNREADABLE, UNREADABLE]);
          break;
        }
        case "cut": {
          const marker = entriesCut(reported);

          entries.push([marker, marker]);
          break;
        }
        case "done": {
          break;
        }
      }

      return { _: "map", entries, size } satisfies ShapeDescriptor;
    }

    if (value instanceof Set) {
      const walk = readSteps(value.values());
      const values: Array<unknown> = [];

      for (let index = 0; index < walk.values.length; index++) {
        values.push(describeStepValue(walk.values[index], depth, seen, budget));
      }

      const reported = collectionSize(value);
      const size = reported ?? values.length;

      switch (walk.end) {
        case "broken": {
          values.push(UNREADABLE);
          break;
        }
        case "cut": {
          values.push(entriesCut(reported));
          break;
        }
        case "done": {
          break;
        }
      }

      return { _: "set", values, size } satisfies ShapeDescriptor;
    }

    const out: Record<string, unknown> = {};

    // Own enumerable keys only. Walking the prototype chain would drag in
    // methods and framework internals, which is noise rather than visibility.
    const allKeys = Object.keys(value);
    const keys = allKeys.slice(0, FULL_MAX_ENTRIES);

    // Guarded per key, around the read as well as the walk below it: the read
    // is where a getter runs, and a throw there would otherwise reach the catch
    // around this whole walk and trade every readable sibling for one marker.
    // The nested walk restores `seen` itself, so nothing needs undoing here.
    for (const key of keys) {
      let encoded: unknown;

      try {
        encoded = describeFull((value as Record<string, unknown>)[key], depth + 1, seen, budget);
      } catch {
        encoded = UNREADABLE;
      }

      setField(out, key, encoded);
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
      out["_type"] = typeName(value);
    }

    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Stands in for a step's `value`, or a half of a map's pair, whose read threw.
 * Private to this module, so no app value can be it.
 */
const UNREADABLE_STEP: unique symbol = Symbol("unreadable step");

const NO_ARGUMENTS: ReadonlyArray<never> = [];

/** What one walk of a collection's iterator read, and how it ended. */
type CollectionWalk = {
  /** Each step's `value`, read once, or {@link UNREADABLE_STEP}. */
  readonly values: Array<unknown>;
  /**
   * `"done"` when the iterator finished, `"cut"` when the entry bound stopped
   * the reads, and `"broken"` when a step could not be read: `next` threw, its
   * result was not an object, or its `done` threw. Without a readable `done`
   * there is no telling whether the walk is over, so it stops there.
   */
  readonly end: "done" | "cut" | "broken";
};

/**
 * Reads a collection's steps by the iterator protocol, as a spread does.
 *
 * The iterator comes from the iterable `entries()` or `values()` returned,
 * because an override may hand back any iterable, and a built-in iterator
 * returns itself. One that is not iterable is used as the iterator itself.
 * `next` is read once and `done` is taken by truthiness, both as the protocol
 * has it.
 *
 * Each step's `value` is read once, so a map's key and value come from the same
 * read. A step whose `value` read throws is still a step: the iterator said it
 * was not done, so the walk goes on past it.
 *
 * The bound stops the reads, not just the output: an iterator runs the app's
 * code and need never finish. One step past the bound says whether anything was
 * cut, so a collection exactly at it reads as whole.
 */
function readSteps(source: object): CollectionWalk {
  const method = (source as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator];
  const iterator: unknown =
    typeof method === "function" ? Reflect.apply(method, source, NO_ARGUMENTS) : source;
  const next = (iterator as { readonly next?: unknown }).next as (this: unknown) => unknown;
  const values: Array<unknown> = [];

  for (;;) {
    let step: unknown;
    let done: unknown;

    try {
      step = Reflect.apply(next, iterator, NO_ARGUMENTS);

      if (step === null || (typeof step !== "object" && typeof step !== "function")) {
        return { values, end: "broken" };
      }

      done = (step as { readonly done?: unknown }).done;
    } catch {
      return { values, end: "broken" };
    }

    if (done) {
      return { values, end: "done" };
    }

    if (values.length === FULL_MAX_ENTRIES) {
      return { values, end: "cut" };
    }

    let entry: unknown;

    try {
      entry = (step as { readonly value?: unknown }).value;
    } catch {
      entry = UNREADABLE_STEP;
    }

    values.push(entry);
  }
}

/** One half of a map step's pair, read on its own guard. */
function halfOf(pair: unknown, index: 0 | 1): unknown {
  if (pair === UNREADABLE_STEP) {
    return UNREADABLE_STEP;
  }

  try {
    return (pair as { readonly [index: number]: unknown })[index];
  } catch {
    return UNREADABLE_STEP;
  }
}

/** A read from {@link readSteps} or {@link halfOf}, walked unless it threw. */
function describeStepValue(
  read: unknown,
  depth: number,
  seen: Set<object>,
  budget: Budget
): unknown {
  return read === UNREADABLE_STEP ? UNREADABLE : describeFull(read, depth + 1, seen, budget);
}

/** The largest array index. `2 ** 32 - 1` is an ordinary key on an array. */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * An array's length, read once.
 *
 * A proxy can make the read throw, and its entries may still be readable. Then
 * the length is one past the highest own index key, enumerable or not, so the
 * entries survive and a hole among them still reads as one. The keys are
 * listed by name alone, which asks the proxy for no descriptors. If they
 * cannot be listed either, nothing about the array is readable and the throw
 * reaches the caller's guard.
 */
function arrayLength(value: ReadonlyArray<unknown>): unknown {
  try {
    return value.length;
  } catch {
    const keys = Object.getOwnPropertyNames(value);
    let length = 0;

    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      const position = Number(key);

      // A canonical array index only: `"01"` and `"1.5"` are ordinary keys,
      // and so is anything past the largest index.
      if (
        position >= length &&
        position <= MAX_ARRAY_INDEX &&
        String(position) === key &&
        Number.isInteger(position)
      ) {
        length = position + 1;
      }
    }

    return length;
  }
}

/**
 * A function's name, or `"anonymous"` when it has none it will give up.
 *
 * Guarded and checked for the reason {@link typeName} is: the read can run a
 * getter, and a name that is not a string — a symbol, say — would throw when
 * written into the marker.
 */
function functionName(value: unknown): string {
  try {
    const name = (value as { readonly name?: unknown }).name;

    return typeof name === "string" && name !== "" ? name : "anonymous";
  } catch {
    return "anonymous";
  }
}

/**
 * A collection's `size`, when reading it neither throws nor gives a number JSON
 * cannot carry. The caller falls back to the entries it counted.
 */
function collectionSize(
  value: ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
): number | undefined {
  try {
    return finiteNumber(value.size);
  } catch {
    return undefined;
  }
}

/**
 * The marker for a list the entry bound cut, with the full count when the value
 * gave one JSON can carry. Without it the marker still says entries were cut;
 * it just cannot say how many.
 */
function entriesCut(length: number | undefined): ShapeDescriptor {
  return length === undefined
    ? { _: "elided", by: "entries" }
    : { _: "elided", by: "entries", length };
}

/**
 * A length or size as the value reports it, when that is a finite number.
 *
 * Both are read through the app's own getters: a `Map` or `Set` subclass can
 * override `size`, and a proxy over an array can answer anything for `length`.
 * A non-finite number there would fail the transport for the whole batch, so a
 * caller falls back to what it counted, or leaves the count out.
 */
function finiteNumber(reported: unknown): number | undefined {
  return typeof reported === "number" && reported - reported === 0 ? reported : undefined;
}
