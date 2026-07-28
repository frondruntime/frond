import { Diagnostics, type Runtime } from "@frondruntime/core";
import type { EncodedEventRecord, ValuePolicy } from "./protocol.ts";

/**
 * What this encoder can produce. All three policies are implemented.
 *
 * `"full"` is a stub in the sense that it has no per-field allowlist and no
 * redaction — it sends what it finds. It is not a stub in its bounds: cycles,
 * depth, and total size are enforced, because those three are not polish. A
 * cyclic graph result would hang the observed app inside its own devtools, and
 * an unbounded one would put a megabyte of node state through a 250ms flush.
 */
export type EncodePolicy = ValuePolicy;

/** Increasing disclosure. The only ordering the clamp below depends on. */
const POLICY_RANK: Record<ValuePolicy, number> = { none: 0, shape: 1, full: 2 };

/**
 * Clamps what the hub asked for to what this app is willing to send.
 *
 * The whole negotiation lives here, in one expression, rather than as a policy
 * check threaded through the encoder: a sender may always answer with less than
 * it was asked for and may never answer with more, and that rule is only
 * trustworthy if there is exactly one place it can be got wrong.
 */
export function resolvePolicy(requested: ValuePolicy, ceiling: ValuePolicy): EncodePolicy {
  return POLICY_RANK[requested] <= POLICY_RANK[ceiling] ? requested : ceiling;
}

const MAX_STRING_LENGTH = 256;
const MAX_KEYS = 32;
const MAX_DEPTH = 3;

/**
 * Bounds for `"full"`, chosen to be generous enough that hitting one is
 * interesting rather than routine — and every one of them announces itself in
 * the output. A cap an agent cannot see is worse than a low cap: it turns
 * "there was more" into "that was all", which is the one thing this feed must
 * never say.
 */
const FULL_MAX_DEPTH = 8;
const FULL_MAX_STRING_LENGTH = 4096;
const FULL_MAX_ENTRIES = 256;
/** Total encoded values per record, across the whole tree. */
const FULL_MAX_NODES = 2000;

/**
 * How far up a `cause` chain to walk. Matches the core default.
 *
 * Chains this long are rare and the frames are small; the expensive parts of a
 * frame — its stack and its payload — are bounded separately below.
 */
const CAUSE_MAX_DEPTH = 8;
const SHAPE_CAUSE_STRING_LENGTH = 256;
const FULL_CAUSE_STRING_LENGTH = 1024;
/** Long enough for the frames that name app code, short enough to not be the payload. */
const FULL_CAUSE_STACK_LENGTH = 2048;

/**
 * A failure, as its chain of causes rather than as its outermost link.
 *
 * The outermost link is almost never the interesting one. Frond wraps failures
 * as it unwinds — `RefreshFailed` around `ActionFailed` around whatever the app
 * actually threw — and those wrappers are `Data.TaggedError`s, whose `message`
 * is the empty string. Encoding one as `{name, message}` therefore yields
 * `{"RefreshFailed", ""}`: the shape of an answer with none of the content.
 *
 * Deliberately not a *projection*. Core can also produce one of those, with a
 * headline, a severity guess and a retryability guess, and it is the right thing
 * to put in front of a human or into an error reporter. This feed is read by an
 * agent, which is better served by the frames themselves — every wrapper, in
 * order, with the fields each one carries — than by someone else's summary of
 * them.
 */
type ErrorDescriptor = {
  readonly _: "error";
  /**
   * The deepest non-empty message in the chain: what actually went wrong.
   *
   * A selection, not a synthesis — it is one of the messages in `causes`,
   * hoisted because it is the field worth reading first and it is otherwise
   * buried under however many wrappers the unwinding added.
   */
  readonly message: string;
  /** Outermost first. Frame `n + 1` is frame `n`'s `cause`. */
  readonly causes: ReadonlyArray<Record<string, unknown>>;
};

/**
 * A structural stand-in for a value the sender will not transmit.
 *
 * `_` rather than `_tag` so a descriptor is never mistaken for a domain tagged
 * union by anything reading the feed.
 */
type ShapeDescriptor =
  | { readonly _: "array"; readonly length: number; readonly of: unknown }
  | {
      readonly _: "object";
      readonly tag?: string;
      readonly keys: ReadonlyArray<string>;
      readonly truncated: boolean;
    }
  | { readonly _: "opaque"; readonly type: string }
  | { readonly _: "string"; readonly length: number; readonly head: string }
  | ErrorDescriptor
  /** A value already on the path above this one. Emitted instead of recursing. */
  | { readonly _: "cycle" }
  /** A bound stopped the walk here. `of` names which one. */
  | { readonly _: "elided"; readonly by: "depth" | "budget" | "entries"; readonly length?: number };

/**
 * Encodes one runtime event for the wire.
 *
 * Classification, work context, and node ids are metadata the runtime already
 * owns and are copied verbatim — they are ids and enum members, never user
 * data. Only the event body goes through {@link describe}.
 */
/**
 * A policy, applied to one answer.
 *
 * One of these per record and per snapshot, because the budget it closes over
 * is the thing worth bounding: what a single answer costs the wire. A record
 * with one enormous field should spend its own allowance rather than be judged
 * field by field, and two records should never be able to spend each other's.
 */
export type ValueEncoder = {
  /** Ordinary app data, redacted according to the policy. */
  readonly value: (value: unknown) => unknown;
  /**
   * A failure, as a chain of causes.
   *
   * Separate from {@link value} because the runtime already knows which is
   * which, and sniffing would get it wrong: a failure that is not an `Error`
   * instance — an Effect `Cause`, a node status — reaches the value encoder as
   * an anonymous bag of keys.
   */
  readonly failure: (value: unknown) => unknown;
};

export function createValueEncoder(policy: EncodePolicy): ValueEncoder {
  const budget: Budget = { remaining: FULL_MAX_NODES };

  return policy === "full"
    ? {
        value: (value) => describeFull(value, 0, new Set<object>(), budget),
        failure: (value) =>
          describeError(value, policy, { depth: 0, seen: new Set<object>(), budget }),
      }
    : {
        value: (value) => describe(value, 0),
        failure: (value) => describeError(value, policy),
      };
}

export function encodeRecord(
  record: Runtime.RuntimeEventRecord,
  policy: EncodePolicy
): EncodedEventRecord {
  const encoder = createValueEncoder(policy);

  // The runtime pulls `failures` straight off the event's own fields, so the
  // same object arrives twice — once as `fields.error`, once as `failures[0]`.
  // Matched by identity so both come out as the same thing; a record that
  // described one failure two different ways would read as two.
  const known = new Set(
    record.failures.filter(
      (failure): failure is object => typeof failure === "object" && failure !== null
    )
  );

  const encodeField = (value: unknown): unknown =>
    typeof value === "object" && value !== null && known.has(value)
      ? encoder.failure(value)
      : encoder.value(value);

  return {
    sequence: record.sequence,
    recordedAt: record.recordedAt,
    tag: record.event._tag,
    category: record.classification.category,
    severity: record.classification.severity,
    timeline: record.classification.timeline,
    reportable: record.classification.reportable,
    workId: record.work.workId,
    parentWorkId: record.work.parentWorkId,
    source: record.work.source,
    reason: record.work.reason,
    priority: record.work.priority,
    nodeIds: record.nodeIds,
    fields: policy === "none" ? {} : describeFields(record.event, encodeField),
    // Failures are causes, not results: their messages are what makes a
    // devtools feed worth reading, so they are described rather than dropped —
    // including under `"none"`, whose subject is values, not what broke.
    //
    // Encoded as failures rather than as values, because that is what the
    // runtime says they are — no sniffing required. Which matters for the ones
    // that are not `Error` instances: an Effect `Cause` reaching the value
    // encoder comes out as a bag of key names.
    failures: record.failures.map(encoder.failure),
  };
}

/** What the `"full"` policy needs in order to encode an error's own payload. */
type FullContext = {
  readonly depth: number;
  readonly seen: Set<object>;
  readonly budget: Budget;
};

/**
 * Serializes a failure and everything that caused it.
 *
 * Thin over `Diagnostics.serializeCauseChain`, which is already the runtime's
 * own answer to "what went wrong" and is already defensive about it — getters
 * that throw, cycles, absent fields. Reusing it means the devtools feed and a
 * runtime sink describe the same failure the same way; hand-rolling a second
 * walk here would eventually mean two accounts of one error that disagree.
 *
 * `preview` is dropped from every frame. Core builds it for a human reading a
 * report, and for an `Error` it is name, message, stack and cause — all of
 * which the frame already carries, one of them recursively, so keeping it would
 * send the chain once per link and add nothing.
 *
 * Two things are `"full"`-only, for the same reason the rest of this encoder
 * withholds things. A `stack` is bulk at `"shape"`: a wall of Effect internals
 * around the two frames that name app code. And `fields` is the error's own
 * payload — `status`, `endpoint`, whatever the app put on it — which is app
 * data by any other name. What survives at `"shape"` is what the chain names
 * explicitly: `tag`, `nodeId`, `operation`, `dependency`, `path`.
 */
function describeError(value: unknown, policy: EncodePolicy, full?: FullContext): ErrorDescriptor {
  const disclose = policy === "full";

  const frames = Diagnostics.serializeCauseChain(value, {
    maxDepth: CAUSE_MAX_DEPTH,
    maxStringLength: disclose ? FULL_CAUSE_STRING_LENGTH : SHAPE_CAUSE_STRING_LENGTH,
    maxStackLength: FULL_CAUSE_STACK_LENGTH,
    maxObjectKeys: disclose ? 20 : 8,
  });

  if (full === undefined) {
    return {
      _: "error",
      message: rootMessage(frames),
      causes: frames.map((frame) => compact({ ...frame, stack: undefined, preview: undefined })),
    };
  }

  // Every link joins the ancestor path for the duration, so a payload field
  // pointing back at an error already on the chain is a cycle rather than a
  // second trip through this function.
  const links = causeValues(value, frames.length);
  const marked = links.filter((link): link is object => typeof link === "object" && link !== null);

  for (const link of marked) {
    full.seen.add(link);
  }

  try {
    return {
      _: "error",
      message: rootMessage(frames),
      causes: frames.map((frame, index) =>
        compact({
          ...frame,
          preview: undefined,
          fields: errorFields(links[index], (own) =>
            describeFull(own, full.depth + 1, full.seen, full.budget)
          ),
        })
      ),
    };
  } finally {
    for (const link of marked) {
      full.seen.delete(link);
    }
  }
}

/**
 * Re-walks the chain for the values behind the frames.
 *
 * Bounded by `count`, which is the frame count rather than a limit of its own:
 * two walks of the same chain that could stop in different places would
 * eventually pair a frame with the wrong value.
 */
function causeValues(root: unknown, count: number): ReadonlyArray<unknown> {
  const values: Array<unknown> = [];
  let current: unknown = root;

  for (let index = 0; index < count; index += 1) {
    values.push(current);

    if (typeof current !== "object" || current === null) {
      break;
    }

    try {
      current = (current as Record<string, unknown>)["cause"];
    } catch {
      break;
    }
  }

  return values;
}

/**
 * Keys a frame already accounts for, by name, and should not repeat.
 *
 * `cause` is the next frame. The rest are what `serializeCauseChain` lifts out
 * of a failure into named fields — sometimes renamed, as `tag` is to `nodeTag`,
 * which is why this list is written against the *source* keys and has to stay
 * in step with that function rather than with the frame type.
 */
const NAMED_ERROR_KEYS = new Set([
  "boundary",
  "cancellation",
  "cause",
  "dependency",
  "invariant",
  "kind",
  "message",
  "name",
  "nodeId",
  "operation",
  "path",
  "stack",
  "tag",
  "timeout",
  "_tag",
]);

/**
 * What a failure carries beyond being a failure.
 *
 * The half of an error a cause chain cannot name in advance: an HTTP status, a
 * request id, the arguments the call was made with. Absent when there is none,
 * which is the common case — a wrapper carries nothing but the fields above.
 */
function errorFields(
  value: unknown,
  encodeValue: (value: unknown) => unknown
): unknown | undefined {
  if (typeof value !== "object" || value === null) {
    // A thrown string or number is its own payload, and the frame's `message`
    // only got a rendering of it.
    return encodeValue(value);
  }

  const own: Record<string, unknown> = {};

  try {
    for (const key of Object.keys(value)) {
      if (!NAMED_ERROR_KEYS.has(key)) {
        own[key] = (value as Record<string, unknown>)[key];
      }
    }
  } catch {
    return undefined;
  }

  return Object.keys(own).length === 0 ? undefined : encodeValue(own);
}

/**
 * The innermost thing that had something to say.
 *
 * Two kinds of frame have nothing: a `Data.TaggedError` wrapper, whose message
 * is empty, and a failure that is not an error at all — a node status, say —
 * for which core falls back to the value's kind. Both are skipped, the second
 * because `"object"` in a field called `message` reads as a message and is not
 * one. When the whole chain is like that, the outermost frame's own name is the
 * most this can honestly say, and the frames below it carry the rest.
 */
function rootMessage(frames: ReadonlyArray<Diagnostics.SerializedCauseFrame>): string {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    const message = frame?.message;

    if (message !== undefined && message !== "" && message !== frame?.valueKind) {
      return message;
    }
  }

  return frames[0]?.tag ?? frames[0]?.name ?? "";
}

/**
 * Drops absent keys.
 *
 * A cause frame declares every field any failure might carry, so most of them
 * are `undefined` on any given one. JSON would drop those anyway; doing it here
 * means the in-memory record the hub retains and renders matches the wire.
 */
function compact(frame: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(frame)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }

  return out;
}

function describeFields(
  event: Runtime.RuntimeEvent,
  encodeValue: (value: unknown) => unknown
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event)) {
    if (key === "_tag") {
      continue;
    }

    fields[key] = encodeValue(value);
  }

  return fields;
}

/**
 * Reduces a value to something JSON-safe that cannot carry user data.
 *
 * Small primitives pass through, because in a runtime event they are ids, tags,
 * timestamps, and flags — the entire signal. Anything structured becomes a
 * descriptor: a node result or an action input is exactly the kind of value
 * that must not leave the process, and it is always an object or an array.
 */
function describe(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  switch (typeof value) {
    case "boolean":
    case "number": {
      return value;
    }
    case "bigint": {
      return { _: "opaque", type: "bigint" } satisfies ShapeDescriptor;
    }
    case "function": {
      return { _: "opaque", type: "function" } satisfies ShapeDescriptor;
    }
    case "symbol": {
      return { _: "opaque", type: "symbol" } satisfies ShapeDescriptor;
    }
    case "string": {
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

function describeStructure(value: object, depth: number): unknown {
  // Before the depth check: a failure nested past the limit is still the reason
  // the event exists, and "an object, elided" is not worth the bytes it saves.
  if (value instanceof Error) {
    return describeError(value, "shape");
  }

  if (depth >= MAX_DEPTH) {
    return {
      _: "opaque",
      type: Array.isArray(value) ? "array" : "object",
    } satisfies ShapeDescriptor;
  }

  if (Array.isArray(value)) {
    const first = value[0];

    return {
      _: "array",
      length: value.length,
      of: first === undefined ? null : describe(first, depth + 1),
    } satisfies ShapeDescriptor;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  // Class instances are app domain objects by construction; their key list is
  // as far as this encoder is willing to go.
  if (prototype !== null && prototype !== Object.prototype) {
    return {
      _: "opaque",
      type: (value.constructor as { readonly name?: string } | undefined)?.name ?? "object",
    } satisfies ShapeDescriptor;
  }

  const keys = Object.keys(value);
  // `_tag` is the one nested field that survives verbatim. A discriminant is
  // structure, not data — and a failure feed that says "an object with these
  // keys" instead of "GraphNodeAcquireFailed" is not worth reading.
  const tag = (value as { readonly _tag?: unknown })._tag;

  if (typeof tag === "string") {
    return {
      _: "object",
      tag,
      keys: keys.slice(0, MAX_KEYS),
      truncated: keys.length > MAX_KEYS,
    } satisfies ShapeDescriptor;
  }

  return {
    _: "object",
    keys: keys.slice(0, MAX_KEYS),
    truncated: keys.length > MAX_KEYS,
  } satisfies ShapeDescriptor;
}

type Budget = { remaining: number };

/**
 * Reduces a value to JSON-safe form while keeping its contents.
 *
 * The counterpart to {@link describe}: same output vocabulary, opposite
 * default. Where the shape encoder asks "what can I say without revealing
 * this", this one asks "what is the least I can leave out".
 *
 * `seen` is the ancestor path, not every value visited. A value that appears
 * twice in a result — a shared config object, the same node referenced by two
 * dependents — is legitimately encoded twice; only a value containing *itself*
 * is a cycle. Tracking all visited values instead would silently blank out
 * shared structure and read as data loss.
 */
function describeFull(value: unknown, depth: number, seen: Set<object>, budget: Budget): unknown {
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
  if (seen.has(value)) {
    return { _: "cycle" } satisfies ShapeDescriptor;
  }

  if (value instanceof Error) {
    const described = describeError(value, "full", { depth, seen, budget });

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
          .map(([key, entry]) => [
            describeFull(key, depth + 1, seen, budget),
            describeFull(entry, depth + 1, seen, budget),
          ]),
        size: value.size,
      };
    }

    if (value instanceof Set) {
      return {
        _: "set",
        values: [...value.values()]
          .slice(0, FULL_MAX_ENTRIES)
          .map((entry) => describeFull(entry, depth + 1, seen, budget)),
        size: value.size,
      };
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
    // as a key, and a silently short key list is the failure this whole file is
    // written against — it reads as "the object had 256 keys", which is a lie
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
