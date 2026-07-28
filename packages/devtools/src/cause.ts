import { Diagnostics } from "@frondruntime/core";
import type { ErrorDescriptor } from "./descriptors.ts";
import type { EncodePolicy } from "./policy.ts";

/**
 * Failures, as chains of causes.
 *
 * Kept apart from the two value encoders because it is not one: a failure is
 * described the same way at every policy, and what varies is only how much of
 * each frame crosses. The value encoders call in here; nothing here calls back
 * out to them except through {@link FullContext}, which is what keeps this
 * module a leaf.
 */

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
 * What the `"full"` policy needs in order to encode an error's own payload.
 *
 * `encodeValue` is injected rather than imported. The full encoder descends into
 * errors and errors descend into their payloads, so calling that encoder by name
 * from here would make the two modules mutually recursive at module scope for no
 * gain — the caller already holds the depth, the `seen` set and the budget that
 * such a call would need, and closing over them is both shorter and the only
 * arrangement in which this file has no dependency on either value encoder.
 *
 * `seen` is still passed through, because this function adds to it: every link
 * of the chain joins the ancestor path for the duration of the walk below it.
 */
export type FullContext = {
  readonly seen: Set<object>;
  readonly encodeValue: (value: unknown) => unknown;
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
export function describeError(
  value: unknown,
  policy: EncodePolicy,
  full?: FullContext
): ErrorDescriptor {
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
          fields: errorFields(links[index], full.encodeValue),
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
 * request id, the arguments the call was made with. `undefined` when there is
 * none, which is the common case — a wrapper carries nothing but the fields
 * above — and {@link compact} drops the key on the way out.
 */
function errorFields(value: unknown, encodeValue: (value: unknown) => unknown): unknown {
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
