/**
 * Opt-in result envelope for imperative per-node internals.
 *
 * Production drivers often need to keep imperative state (SDK handles,
 * sockets, AbortControllers) alongside a node's public result without leaking
 * it to consumers, projections, or serialization. This module standardizes
 * that idiom on one Frond-owned slot instead of per-package private symbols.
 *
 * Contract:
 *
 * - Opt-in only. The runtime has no knowledge of the envelope: it never reads,
 *   projects, serializes, or manages the slot. Authors attach and read it
 *   explicitly through the helpers below.
 * - The slot is non-enumerable, so it never appears in `JSON.stringify`,
 *   `Object.keys`, `Object.entries`, or object spread output. Spreading an
 *   enveloped result is safe in the leak direction (the internal never escapes
 *   into the copy) but lossy in the carry direction (the copy no longer has
 *   the slot) - see `carryInternal`.
 * - Prefer `patchResult` (in-place field mutation) over whole-object result
 *   replacement for enveloped results, so the enveloped object reference - and
 *   with it the slot - survives updates.
 * - One standard slot keeps future runtime features (auto-dispose at close,
 *   devtools display of internal state) possible without any new authoring
 *   API, which per-package private symbols would make impossible.
 */

const internalSlot: unique symbol = Symbol("frond.envelope/internal");

/**
 * A public result `Pub` carrying a hidden readonly internal slot of type
 * `Int`. The slot is keyed by a module-private symbol; use `internalOf` to
 * read it and `withInternal`/`carryInternal` to attach it.
 */
export type WithInternal<Pub, Int> = Pub & {
  readonly [internalSlot]: Int;
};

/**
 * Attaches `internal` to `result` under the Frond envelope slot and returns
 * the same object, typed as `WithInternal`.
 *
 * The slot is defined non-enumerable: it is invisible to `JSON.stringify`,
 * `Object.keys`, and spread output, so internals never leak out of an
 * enveloped result. The inverse direction is the footgun: a spread copy of an
 * enveloped result silently drops the slot - see `carryInternal`.
 */
export function withInternal<Pub extends object, Int>(
  result: Pub,
  internal: Int
): WithInternal<Pub, Int> {
  Object.defineProperty(result, internalSlot, {
    value: internal,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return result as WithInternal<Pub, Int>;
}

/**
 * Reads the internal envelope slot from an enveloped result.
 *
 * Throws a `TypeError` when the slot is missing - typically because the
 * result object was replaced by a spread copy without `carryInternal`, or
 * was never enveloped with `withInternal`.
 */
export function internalOf<Int>(result: WithInternal<object, Int>): Int {
  if (!(internalSlot in result)) {
    throw new TypeError(
      "internalOf(result): no internal envelope slot on this result. " +
        "Attach one with withInternal(result, internal). If the result was " +
        "replaced by object spread, re-attach the previous internal with " +
        "carryInternal(prev, next)."
    );
  }
  return result[internalSlot];
}

/**
 * Re-attaches `prev`'s internal onto a replacement result and returns `next`,
 * typed as `WithInternal`.
 *
 * This is the sanctioned fix for the spread footgun: object spread drops
 * non-enumerable slots, so `setResult(cur => ({ ...cur }))` silently loses
 * the internal. Wrap the replacement instead:
 * `setResult(cur => carryInternal(cur, { ...cur }))`. Prefer `patchResult`
 * where possible so the object reference never changes in the first place.
 */
export function carryInternal<Pub extends object, Int>(
  prev: WithInternal<object, Int>,
  next: Pub
): WithInternal<Pub, Int> {
  return withInternal(next, internalOf(prev));
}
