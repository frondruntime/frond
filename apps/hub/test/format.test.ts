import { describe, expect, test } from "bun:test";
import {
  clip,
  clock,
  count,
  downsample,
  pad,
  padStart,
  severityColor,
  timelineColor,
  tint,
} from "../src/ui/format.ts";

/**
 * The invariant the whole module exists to keep. A column wider than its budget
 * pushes everything right of it off the screen, and a terminal reports that by
 * rendering it — there is no error to catch, so it is asserted here instead.
 */
describe("column widths", () => {
  const widths = [0, 1, 2, 3, 5, 7, 9, 20, 30];
  const values = ["", "a", "ab", "abc", "orders:v1", "x".repeat(64), "a-name-of-exactly-20c"];

  test("pad returns exactly the width it was given, for every input", () => {
    for (const width of widths) {
      for (const value of values) {
        expect(pad(value, width)).toHaveLength(width);
      }
    }
  });

  test("clip never returns more than the width it was given", () => {
    for (const width of widths) {
      for (const value of values) {
        expect(clip(value, width).length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("pad", () => {
  /**
   * The bug this test exists for: the guard was `>=`, so a value that fit its
   * column exactly was still ellipsized — spending two real characters to
   * announce a truncation that had not happened. A twenty-character app name in
   * a twenty-wide column lost its last two letters and gained a `…`.
   */
  test("a value that fits exactly is left whole", () => {
    const exact = "12345678901234567890";

    expect(exact).toHaveLength(20);
    expect(pad(exact, 20)).toBe(exact);
  });

  test("a value one short of the width is padded, not cut", () => {
    expect(pad("1234567890123456789", 20)).toBe("1234567890123456789 ");
  });

  test("a value past the width is cut and marked", () => {
    expect(pad("123456789012345678901", 20)).toBe("123456789012345678… ");
  });

  test("a short value is padded out on the right", () => {
    expect(pad("ab", 5)).toBe("ab   ");
  });

  /**
   * Unreachable from the dashboard, whose narrowest column is seven. Asserted
   * because the previous version answered a width of one with three characters,
   * which is the kind of thing that stays harmless right up until a caller
   * computes a width instead of naming one.
   */
  test("widths too narrow for the marker cut silently rather than overflow", () => {
    expect(pad("ab", 1)).toBe("a");
    expect(pad("abc", 2)).toBe("ab");
    expect(pad("ab", 0)).toBe("");
  });
});

describe("clip", () => {
  test("a value within the width is untouched", () => {
    expect(clip("orders:v1", 20)).toBe("orders:v1");
    expect(clip("abcde", 5)).toBe("abcde");
  });

  test("the ellipsis is charged against the width, not added to it", () => {
    expect(clip("abcdef", 3)).toBe("ab…");
  });

  /**
   * Reachable: `EventLine` gives the node id whatever is left of the terminal
   * after a sixty-column prefix, so any narrower terminal asks for zero. A lone
   * `…` there says nothing except that the window is small.
   */
  test("a zero width yields nothing rather than a stray ellipsis", () => {
    expect(clip("orders:v1", 0)).toBe("");
    expect(clip("orders:v1", -4)).toBe("");
  });
});

describe("padStart", () => {
  test("pads on the left and leaves an over-long value alone", () => {
    expect(padStart("42", 6)).toBe("    42");
    expect(padStart("1234567", 4)).toBe("1234567");
  });
});

describe("downsample", () => {
  /**
   * The reason this is not an average and not a stride. A one-second burst is
   * the only thing anyone reads a sparkline for, and both of the other reductions
   * lose it — an average dilutes it, a stride can skip the bucket entirely.
   */
  test("a lone spike survives being reduced", () => {
    const buckets = new Array<number>(60).fill(0);
    buckets[37] = 2000;

    const out = downsample(buckets, 20);

    expect(out).toHaveLength(20);
    expect(Math.max(...out)).toBe(2000);
  });

  test("fewer buckets than columns are returned as they are", () => {
    expect(downsample([1, 2, 3], 20)).toEqual([1, 2, 3]);
  });

  test("the result is a copy, not the input", () => {
    const buckets = [1, 2, 3];

    expect(downsample(buckets, 20)).not.toBe(buckets);
  });

  test("every group contributes its own peak", () => {
    expect(downsample([0, 5, 0, 9], 2)).toEqual([5, 9]);
  });
});

describe("tint", () => {
  /**
   * `exactOptionalPropertyTypes` makes `color={undefined}` a type error rather
   * than "use the default", so the key has to be absent — not present and
   * undefined. `toEqual` passes for both; `Object.keys` is the assertion that
   * tells them apart.
   */
  test("an absent colour yields no key at all", () => {
    expect(Object.keys(tint(undefined))).toEqual([]);
  });

  test("a colour is passed through", () => {
    expect(tint("cyan")).toEqual({ color: "cyan" });
  });
});

describe("colours", () => {
  test("each timeline has its own colour, and unknown ones default", () => {
    expect(timelineColor("work")).toBe("magenta");
    expect(timelineColor("state")).toBe("blue");
    expect(timelineColor("system")).toBe("gray");
    expect(timelineColor("something-else" as never)).toBeUndefined();
  });

  test("only error and warning are coloured", () => {
    expect(severityColor("error")).toBe("red");
    expect(severityColor("warning")).toBe("yellow");
    expect(severityColor("info" as never)).toBeUndefined();
  });
});

describe("clock", () => {
  /**
   * Asserted against the same `Date`'s own local getters rather than a literal:
   * the function renders local time, so a literal would pass only in whichever
   * timezone it was written in.
   */
  test("renders local wall time to the millisecond", () => {
    const at = Date.UTC(2024, 4, 17, 9, 8, 7, 65);
    const date = new Date(at);
    const pair = (value: number): string => String(value).padStart(2, "0");

    expect(clock(at)).toBe(
      `${pair(date.getHours())}:${pair(date.getMinutes())}:${pair(date.getSeconds())}.065`
    );
  });

  test("every field is zero-padded to a fixed width", () => {
    expect(clock(Date.UTC(2024, 0, 1, 0, 0, 0, 5))).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe("count", () => {
  test("groups thousands so a rate is readable at a glance", () => {
    expect(count(1234567)).toBe("1,234,567");
    expect(count(0)).toBe("0");
  });
});
