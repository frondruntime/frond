import { describe, expect, test } from "bun:test";
import {
  advanceRate,
  emptyRate,
  RATE_BUCKET_COUNT,
  RATE_BUCKET_MS,
  recordRate,
} from "../src/rate.ts";

/** An arbitrary instant already aligned to the bucket grid. */
const T0 = 1_700_000_000_000;

describe("rate window", () => {
  test("a fresh window is a minute of zeroes aligned to the bucket grid", () => {
    const window = emptyRate(T0 + 137);

    expect(window.buckets).toHaveLength(RATE_BUCKET_COUNT);
    expect(window.buckets.every((value) => value === 0)).toBe(true);
    expect(window.bucketAt).toBe(T0);
  });

  test("counts land in the newest bucket", () => {
    const window = recordRate(emptyRate(T0), T0 + 10, 3);

    expect(window.buckets.at(-1)).toBe(3);
    expect(window.buckets.slice(0, -1).every((value) => value === 0)).toBe(true);
  });

  test("two batches inside the same second share a bucket", () => {
    const window = recordRate(recordRate(emptyRate(T0), T0 + 10, 3), T0 + 900, 4);

    expect(window.buckets.at(-1)).toBe(7);
    expect(window.bucketAt).toBe(T0);
  });

  /**
   * The point of the whole type: an idle app never ingests, so nothing would
   * move its window. A count that stayed put would report the last busy second
   * forever.
   */
  test("advancing without recording ages counts backwards through the window", () => {
    const busy = recordRate(emptyRate(T0), T0, 5);
    const later = advanceRate(busy, T0 + 3 * RATE_BUCKET_MS);

    expect(later.buckets.at(-1)).toBe(0);
    expect(later.buckets.at(-4)).toBe(5);
    expect(later.bucketAt).toBe(T0 + 3 * RATE_BUCKET_MS);
  });

  test("a gap longer than the window clears it rather than shifting forever", () => {
    const busy = recordRate(emptyRate(T0), T0, 5);
    const later = advanceRate(busy, T0 + (RATE_BUCKET_COUNT + 10) * RATE_BUCKET_MS);

    expect(later.buckets).toHaveLength(RATE_BUCKET_COUNT);
    expect(later.buckets.every((value) => value === 0)).toBe(true);
    expect(later.bucketAt).toBe(T0 + (RATE_BUCKET_COUNT + 10) * RATE_BUCKET_MS);
  });

  test("a count older than the window has fallen off the end", () => {
    const busy = recordRate(emptyRate(T0), T0, 5);
    const later = advanceRate(busy, T0 + RATE_BUCKET_COUNT * RATE_BUCKET_MS);

    expect(later.buckets.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  /**
   * A backwards clock is not hypothetical — NTP steps and suspend/resume both
   * do it. Rewinding would drop real counts; standing still loses nothing.
   */
  test("a clock that jumps backwards leaves the window alone", () => {
    const busy = recordRate(emptyRate(T0), T0, 5);

    expect(advanceRate(busy, T0 - 10 * RATE_BUCKET_MS)).toBe(busy);
  });

  test("recording after a gap ages the old count and keeps the new one", () => {
    const first = recordRate(emptyRate(T0), T0, 5);
    const second = recordRate(first, T0 + 2 * RATE_BUCKET_MS, 9);

    expect(second.buckets.at(-1)).toBe(9);
    expect(second.buckets.at(-3)).toBe(5);
  });
});
