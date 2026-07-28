import { Diagnostics, type Runtime } from "@frondruntime/core";
import type { EncodedEventRecord, ValuePolicy } from "./protocol.ts";

/**
 * What this encoder can produce. All three policies are implemented.
 *
 * `"full"` is a stub in the sense that it has no per-field allowlist and no
 * redaction — it sends what it finds. It is not a stub in its bounds: cycles,
 * depth, and breadth are enforced, because those three are not polish. A cyclic
 * or unboundedly deep graph result would hang the observed app inside its own
 * devtools, on its own event loop.
 *
 * What those bounds are not is a size budget. This socket is loopback and the
 * eventual reader is an agent's context window, so the scarce resource is the
 * reader's attention rather than the wire — which is why `"shape"` spends real
 * effort being terse and `"full"` spends none.
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
const FULL_MAX_NODES = 50000;

/**
 * How far up a `cause` chain to walk. Matches the core default.
 *
 * Chains this long are rare and the frames are small; the expensive parts of a
 * frame — its stack and its payload — are bounded separately below.
 */
const CAUSE_MAX_DEPTH = 8;
const SHAPE_CAUSE_STRING_LENGTH = 256;
const FULL_CAUSE_STRING_LENGTH = 1024;
/**
 * How much stack to take from core before selecting frames out of it.
 *
 * Deliberately far above anything a real stack reaches: cutting here cuts by
 * character, which is the thing {@link abridgeStack} exists to stop doing. This
 * is a guard against a fabricated `stack` string, not a budget.
 */
const CAUSE_STACK_SOURCE_LENGTH = 32768;
/**
 * How many frames survive selection.
 *
 * The frame that names app code is almost always within the first few once the
 * library frames are gone; fifteen is room for a couple of layers of wrapping on
 * top of that without the trace becoming the record.
 */
const KEPT_STACK_FRAMES = 15;
/** Kept from a trace that is library frames all the way down. See {@link abridgeStack}. */
const LIBRARY_ONLY_STACK_FRAMES = 2;
/** The fallback bound, for a `stack` this cannot read as frames at all. */
const FULL_CAUSE_STACK_LENGTH = 2048;

/**
 * Frames, in the two formats a JS runtime produces.
 *
 * V8 (Node, Bun, Chromium) indents every frame with `at `; JSC and SpiderMonkey
 * write `name@url:line:column`. Matched rather than assumed because the header
 * of a stack is the error's own message, which is app text and must not be
 * mistaken for a frame and dropped.
 */
const V8_STACK_FRAME = /^\s*at\s\S/;
// Anchored and whitespace-free on both sides of the `@`, because a JSC stack has
// no header line to protect it: a message like `Cannot find module
// /app/node_modules/x/index.js:1:1` ends the way a frame ends, and an unanchored
// pattern would call line 0 a frame, leaving `header` empty and feeding the
// message itself to the library filter.
const AT_STACK_FRAME = /^\S*@\S*:\d+:\d+\s*$/;

/**
 * Frames that belong to someone else's code.
 *
 * `node_modules` is the whole point; the rest are the same idea for code that
 * has no file in the tree at all — Node's builtins, Bun's, and native frames.
 * Bun writes its own native frames as `at moduleEvaluation (native:1:11)` rather
 * than in either of the parenthesized spellings, hence the bare `native:`.
 */
const LIBRARY_STACK_FRAME = /node_modules|node:|bun:|native:|\(native\)|\[native code]/;

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
 * A marker that survived where a value did not.
 *
 * Only ever emitted alongside real data — at `"full"`, and at `"shape"` for a
 * string long enough to be cut — which is why these stay objects while the
 * `"shape"` vocabulary below is strings. A reader looking at real values has to
 * be able to tell a marker from one of them, and `{_: …}` is that tell.
 *
 * `_` rather than `_tag` so a descriptor is never mistaken for a domain tagged
 * union by anything reading the feed.
 */
type ShapeDescriptor =
  | { readonly _: "opaque"; readonly type: string }
  | { readonly _: "string"; readonly length: number; readonly head: string }
  | ErrorDescriptor
  /** A value already on the path above this one. Emitted instead of recursing. */
  | { readonly _: "cycle" }
  /** A bound stopped the walk here. `by` names which one. */
  | { readonly _: "elided"; readonly by: "depth" | "budget" | "entries"; readonly length?: number };

/**
 * What `"none"` puts where a value was.
 *
 * A word, not a descriptor: `"none"` is the policy that has decided the reader
 * learns nothing about this value, and a key list or a type name is something.
 * The same marker for every value, so it cannot be read as a shape either.
 */
const WITHHELD = "withheld";

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
  // Spelled out rather than folded into the `"shape"` branch. Falling through
  // was the bug: `"none"` reached the shape encoder and emitted key lists for
  // every node in a graph snapshot, which is a description of app data by an
  // app that had said it would send none.
  if (policy === "none") {
    return {
      value: () => WITHHELD,
      // Still a chain, because "there is an error here" is not the value's
      // data. What crosses is what the failure names about itself — its tags,
      // its node, the innermost message — and never its payload or its stack,
      // which `describeError` withholds at anything below `"full"`.
      failure: (value) => describeError(value, policy),
    };
  }

  if (policy === "shape") {
    return {
      value: (value) => describe(value, 0),
      failure: (value) => describeError(value, policy),
    };
  }

  const budget: Budget = { remaining: FULL_MAX_NODES };

  return {
    value: (value) => describeFull(value, 0, new Set<object>(), budget),
    failure: (value) => describeError(value, policy, { depth: 0, seen: new Set<object>(), budget }),
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
    // Asked for whole, then abridged by frame below. Core can only cut by
    // character, which is exactly the cut that loses the frame worth keeping.
    maxStackLength: CAUSE_STACK_SOURCE_LENGTH,
    maxObjectKeys: disclose ? 20 : 8,
  });

  if (full === undefined) {
    // `path` and `valueKind` are the two frame fields that describe the app's
    // data rather than the runtime's: a path is a list of the app's own key
    // names, and a value kind says whether what failed was an array or an
    // object. Both are shape by any definition, so `"none"` — whose whole
    // contract is that no shape crosses — drops them. The message still
    // crosses at every policy; that is deliberate, and it is the one thing a
    // reader cannot diagnose without.
    const shed = policy === "none" ? { path: undefined, valueKind: undefined } : {};

    return {
      _: "error",
      message: rootMessage(frames),
      causes: frames.map((frame) =>
        compact({ ...frame, ...shed, stack: undefined, preview: undefined })
      ),
    };
  }

  // Every link joins the ancestor path for the duration, so a payload field
  // pointing back at an error already on the chain is a cycle rather than a
  // second trip through this function.
  //
  // Only what this call actually inserted comes back out. A link an enclosing
  // frame is still standing on has to stay marked: an error reached through an
  // app object whose payload points back at that object is the ordinary shape of
  // a wrapped failure, and un-marking it there would let the walk descend into
  // the ancestor instead of naming the cycle.
  const links = causeValues(value, frames.length);
  const marked = links.filter(
    (link): link is object => typeof link === "object" && link !== null && !full.seen.has(link)
  );

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
          stack: frame.stack === undefined ? undefined : abridgeStack(frame.stack),
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
 * A stack, selected by frame instead of cut by character.
 *
 * A raw stack is mostly other people's code — Effect's fiber runtime, the test
 * runner, the module loader — and the frames that name the app are scattered
 * through it rather than at the top. Truncating at a character count therefore
 * spends the budget on internals and can cut the one frame a reader needed, so
 * this drops library frames outright and keeps the first {@link
 * KEPT_STACK_FRAMES} of what is left.
 *
 * The dropped count is not decoration. An abridged trace that does not say it is
 * abridged reads as "this is where it came from", and a reader who then cannot
 * find the caller concludes the wrong thing about the code rather than about the
 * trace.
 *
 * Two cases deliberately do not select. A trace that is library frames all the
 * way down — a failure raised entirely inside a dependency — still says where in
 * that dependency, and an empty stack would throw that away for nothing. And a
 * `stack` with no recognizable frames is not a stack this can reason about, so
 * it falls back to the character bound rather than guessing.
 */
function abridgeStack(stack: string): string {
  const lines = stack.split("\n");
  const first = lines.findIndex(isStackFrame);

  if (first === -1) {
    return stack.length <= FULL_CAUSE_STACK_LENGTH
      ? stack
      : `${stack.slice(0, FULL_CAUSE_STACK_LENGTH)}…`;
  }

  // Everything above the first frame is the error's own header, kept whole: it
  // is the name and message, which is the part a reader reads first.
  const header = lines.slice(0, first);
  // Counted against everything below the header, not just the lines the two
  // patterns recognize. JSC writes frames this cannot parse — `promiseReactionJob@[native code]`
  // has no `:line:col` — and dropping those out of the denominator would let the
  // trace claim it accounted for what it removed while quietly removing more.
  const body = lines.slice(first).filter((line) => line.trim() !== "");
  const frames = body.filter(isStackFrame);
  const own = frames.filter((line) => !LIBRARY_STACK_FRAME.test(line));
  const kept = (own.length === 0 ? frames.slice(0, LIBRARY_ONLY_STACK_FRAMES) : own).slice(
    0,
    KEPT_STACK_FRAMES
  );
  const dropped = body.length - kept.length;

  if (dropped === 0) {
    return [...header, ...kept].join("\n");
  }

  return [
    ...header,
    ...kept,
    `    … ${dropped} frame${dropped === 1 ? "" : "s"} dropped: library internals, unrecognized lines, and any past the first ${KEPT_STACK_FRAMES}`,
  ].join("\n");
}

function isStackFrame(line: string): boolean {
  return V8_STACK_FRAME.test(line) || AT_STACK_FRAME.test(line);
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
function describe(value: unknown, depth: number): unknown {
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

/**
 * Reading a value can run the app's code, so reading it can throw.
 *
 * A getter that throws, a revoked `Proxy` — a finalized immer draft, a torn-down
 * reactive scope — a prototype whose `constructor` is a throwing getter: every
 * one of those turns `Object.keys` or an `instanceof` into an exception, and
 * none of them is exotic in a frontend app.
 *
 * The consequence is what makes this worth guarding rather than letting throw.
 * On the event path the encoder runs inside the app's own observer, and core
 * routes an observer failure to sinks only — so the record would vanish without
 * incrementing `dropped`, which is exactly the "did not happen" versus "was
 * lost" distinction the protocol exists to preserve. On the snapshot path one
 * unreadable node would fail the whole graph read and leave a reader with
 * nothing instead of with 299 good rows and one marked hole.
 *
 * `{_: "opaque"}` is the honest answer: there is something here, and this
 * encoder could not look at it. The thrown error's own message is not carried —
 * it comes from app code, and a `"shape"` read that let one through would be a
 * hole in the policy rather than a diagnostic.
 */
const UNREADABLE = { _: "opaque", type: "unreadable" } satisfies ShapeDescriptor;

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
 * Distinct from {@link describe} because that answers with the value where it
 * can — a number stays a number — and a position naming a type needs the type.
 * `typeof` supplies every primitive name; structured entries recurse, so an
 * array of objects reads `{id,name}[3]` and inherits the depth bound with it.
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

type Budget = { remaining: number };

/**
 * Reduces a value to JSON-safe form while keeping its contents.
 *
 * The counterpart to {@link describe}, and the opposite default: where the
 * shape encoder asks "what can I say without revealing this", this one asks
 * "what is the least I can leave out".
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
