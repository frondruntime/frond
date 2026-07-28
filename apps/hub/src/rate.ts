/**
 * Width of one bucket in the rate window.
 *
 * One second, so a bucket index is a second ago and the sparkline needs no
 * legend to be read.
 */
export const RATE_BUCKET_MS = 1000;

/** How many buckets the window keeps. Sixty of them is one minute of history. */
export const RATE_BUCKET_COUNT = 60;

/**
 * Events per second over the last minute, as a fixed-size window.
 *
 * Fixed-size and derived at ingest rather than computed from retained history:
 * the ring holds ten thousand records and is deliberately not observable, so a
 * chart fed from it would either copy that history on every frame or force the
 * ring to become something it is not. Sixty numbers cost nothing to carry on a
 * view that is already replaced wholesale each batch.
 *
 * `buckets` runs oldest to newest, so the last entry is the second in progress.
 */
export type RateWindow = {
  readonly buckets: ReadonlyArray<number>;
  /** Start of the newest bucket, in epoch millis, floored to the bucket grid. */
  readonly bucketAt: number;
};

function bucketStart(at: number): number {
  return Math.floor(at / RATE_BUCKET_MS) * RATE_BUCKET_MS;
}

function zeroed(): Array<number> {
  return new Array<number>(RATE_BUCKET_COUNT).fill(0);
}

export function emptyRate(at: number): RateWindow {
  return { buckets: zeroed(), bucketAt: bucketStart(at) };
}

/**
 * Rolls the window forward to `now` without recording anything.
 *
 * Separate from `recordRate` and exported because an idle app never ingests, so
 * nothing would advance it. A window that only moves when events arrive shows
 * the last busy second forever — a chart that goes wrong precisely when the app
 * it describes has stopped, which is when someone is most likely looking at it.
 *
 * Pure, so the UI can call it at render time against the wall clock rather than
 * a ticker running inside the graph.
 */
export function advanceRate(window: RateWindow, now: number): RateWindow {
  const target = bucketStart(now);
  const shift = (target - window.bucketAt) / RATE_BUCKET_MS;

  // Clock moved backwards, or we are still inside the same second. Rewinding on
  // a backwards jump would drop real counts; standing still loses nothing.
  if (shift <= 0) {
    return window;
  }

  if (shift >= RATE_BUCKET_COUNT) {
    return { buckets: zeroed(), bucketAt: target };
  }

  const buckets = [...window.buckets.slice(shift), ...new Array<number>(shift).fill(0)];

  return { buckets, bucketAt: target };
}

/** Adds `count` events to the bucket covering `now`, rolling forward first. */
export function recordRate(window: RateWindow, now: number, count: number): RateWindow {
  const advanced = advanceRate(window, now);
  const buckets = [...advanced.buckets];
  const newest = buckets.length - 1;

  buckets[newest] = (buckets[newest] ?? 0) + count;

  return { buckets, bucketAt: advanced.bucketAt };
}
