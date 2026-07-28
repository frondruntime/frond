import type { EncodedEventRecord } from "@frondruntime/devtools";

/**
 * The dashboard's character layer: colour choices and column arithmetic.
 *
 * Split out of `App.tsx` because none of it is React and all of it is the part
 * that can be wrong in a way nobody notices. A column that overflows its width
 * pushes the rest of the row off screen, and the terminal simply renders the
 * result — there is no error, only a display that quietly stops lining up. These
 * are pure string functions so that can be asserted instead of eyeballed.
 *
 * The contract every width-taking function here keeps: **the result is never
 * wider than `width`.** {@link pad} returns exactly that many columns, {@link
 * clip} returns at most that many, and both answer an impossible width with the
 * empty string rather than with a stray ellipsis.
 */

/**
 * Spreads a colour prop, or nothing at all.
 *
 * `exactOptionalPropertyTypes` is on, so `color={undefined}` is a type error
 * rather than "leave it alone"; omitting the key is how you say default.
 */
export function tint(color: string | undefined): { readonly color?: string } {
  return color === undefined ? {} : { color };
}

export function timelineColor(timeline: EncodedEventRecord["timeline"]): string | undefined {
  switch (timeline) {
    case "work":
      return "magenta";
    case "state":
      return "blue";
    case "system":
      return "gray";
    default:
      return undefined;
  }
}

export function severityColor(severity: EncodedEventRecord["severity"]): string | undefined {
  switch (severity) {
    case "error":
      return "red";
    case "warning":
      return "yellow";
    default:
      return undefined;
  }
}

export function clock(at: number): string {
  const date = new Date(at);
  const pair = (value: number): string => String(value).padStart(2, "0");

  return `${pair(date.getHours())}:${pair(date.getMinutes())}:${pair(date.getSeconds())}.${String(
    date.getMilliseconds()
  ).padStart(3, "0")}`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Cuts a string to at most `width` columns, marking that it was cut.
 *
 * The ellipsis is charged against the width rather than added to it, so the
 * result fits the space it was given. A width with no room for even that — the
 * event line's node-id budget goes to zero on a terminal under about sixty
 * columns — yields nothing at all, because a lone `…` in a column too narrow to
 * hold anything says only that the terminal is small.
 */
export function clip(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

/**
 * Fills a string out to exactly `width` columns, cutting it if it overruns.
 *
 * Strictly longer than the width, not as long as it: a value that fits exactly
 * is the value, and the earlier `>=` spent two of its characters on an ellipsis
 * announcing a truncation that had not happened — so an app named exactly
 * `NAME_WIDTH` characters lost its last two for nothing.
 *
 * Below three columns there is no room for the `… ` marker, so the cut is made
 * silently. That case is unreachable from the dashboard, whose narrowest column
 * is seven; it is handled because a function that returns three characters for a
 * width of one is a layout bug waiting for the first caller who computes a width
 * instead of naming one.
 */
export function pad(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value.padEnd(width, " ");
  }

  return width < 3 ? value.slice(0, width) : `${value.slice(0, width - 2)}… `;
}

export function padStart(value: string, width: number): string {
  return value.padStart(width, " ");
}

/**
 * Reduces `buckets` to `width` columns by taking the peak of each group.
 *
 * Averaging would be the other option and is the wrong one here: a burst of two
 * thousand events in one second, averaged across three, becomes a bump.
 */
export function downsample(buckets: ReadonlyArray<number>, width: number): Array<number> {
  if (buckets.length <= width) {
    return [...buckets];
  }

  const out = new Array<number>(width).fill(0);

  for (let index = 0; index < buckets.length; index += 1) {
    const slot = Math.min(width - 1, Math.floor((index / buckets.length) * width));

    out[slot] = Math.max(out[slot] ?? 0, buckets[index] ?? 0);
  }

  return out;
}
