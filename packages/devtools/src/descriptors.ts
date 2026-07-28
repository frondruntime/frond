/**
 * The vocabulary both encoders emit where a value did not survive whole.
 *
 * Shared rather than duplicated because the two encoders disagree about almost
 * everything else — `"shape"` says as little as it can and `"full"` says as much
 * as it can — and the one thing they must agree on is how a reader tells a
 * marker from data.
 */

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
export type ErrorDescriptor = {
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
 * `"shape"` vocabulary is strings. A reader looking at real values has to be
 * able to tell a marker from one of them, and `{_: …}` is that tell.
 *
 * `_` rather than `_tag` so a descriptor is never mistaken for a domain tagged
 * union by anything reading the feed.
 *
 * Two markers are *keys* rather than arms of this union, because they annotate
 * an encoded object from the inside and have nowhere else to go: `"full"` adds
 * `_type` — a string — to a class instance, and `_elided` (whose value is the
 * `"elided"` arm below) to an object whose key list was cut. Both are listed
 * here so this type stays the one place the vocabulary is written down.
 */
export type ShapeDescriptor =
  | { readonly _: "opaque"; readonly type: string }
  | { readonly _: "string"; readonly length: number; readonly head: string }
  | ErrorDescriptor
  /** A value already on the path above this one. Emitted instead of recursing. */
  | { readonly _: "cycle" }
  /** A bound stopped the walk here. `by` names which one. */
  | { readonly _: "elided"; readonly by: "depth" | "budget" | "entries"; readonly length?: number }
  /**
   * Collections, at `"full"` only — `"shape"` names them `Map(3)` and `Set(3)`.
   * `size` is the collection's real size; `entries` and `values` are what
   * survived the entry bound, so the two disagree when one was hit.
   */
  | {
      readonly _: "map";
      readonly entries: ReadonlyArray<readonly [unknown, unknown]>;
      readonly size: number;
    }
  | { readonly _: "set"; readonly values: ReadonlyArray<unknown>; readonly size: number };

/**
 * What `"none"` puts where a value was.
 *
 * A word, not a descriptor: `"none"` is the policy that has decided the reader
 * learns nothing about this value, and a key list or a type name is something.
 * The same marker for every value, so it cannot be read as a shape either.
 */
export const WITHHELD = "withheld";

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
export const UNREADABLE = { _: "opaque", type: "unreadable" } satisfies ShapeDescriptor;
