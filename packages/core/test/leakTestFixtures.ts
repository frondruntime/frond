import { heapStats } from "bun:jsc";

/**
 * Leak checks by growth, not by collection.
 *
 * JavaScriptCore scans the stack conservatively, and jsdom and React keep
 * some trees alive, so "every object was collected" fails on healthy code.
 * Instead, a check warms a round up, then counts the objects alive after
 * each of several windows of `n` rounds, and reports how many objects a round
 * left alive. A path that keeps nothing per round
 * reports about 0; one that keeps an object per round reports at least 1.
 */

/**
 * Rounds per window inside the test suite; the leak run raises it. JavaScriptCore
 * fills caches by a few hundred objects at a time, so with all the leak files
 * in one process 50 rounds read up to 25 objects a round of noise; 200 keeps
 * the noise under the slack.
 */
export const leakRounds = Number(process.env.FROND_LEAK_ROUNDS ?? 200);

/** Objects one round may leave alive on average before a check fails. */
export const leakSlackPerRound = 0.5;

export async function collectGarbage(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export type Growth = {
  /** Objects a round left alive: the second-lowest window. */
  readonly perRound: number;
  /** Objects a round left alive in each window, lowest first. */
  readonly perWindow: ReadonlyArray<number>;
  /** Object types whose count grew, largest growth first. */
  readonly grownTypes: ReadonlyArray<readonly [string, number]>;
};

// Windows measured after the warm-up. A leak grows in every window. Noise
// does not: a cache that fills once, or a batch of objects the collector
// keeps a little longer, lands in one window, and their release later makes
// one window negative. So the check takes the second-lowest window.
const windows = 6;
const warmUpRounds = 100;

/**
 * Warms `round` up, runs it in `windows` windows of `rounds` rounds each, and
 * reports the objects a round left alive.
 */
export async function objectGrowth(
  round: (index: number) => unknown,
  rounds: number = leakRounds
): Promise<Growth> {
  let index = 0;
  // The first rounds compile code and fill caches; let them settle first.
  for (const end = Math.max(rounds, warmUpRounds); index < end; index += 1) await round(index);
  await collectGarbage();
  const first = heapStats();
  const perWindow: Array<number> = [];
  let previous = first;
  for (let window = 0; window < windows; window += 1) {
    for (const end = index + rounds; index < end; index += 1) await round(index);
    await collectGarbage();
    const stats = heapStats();
    perWindow.push((stats.objectCount - previous.objectCount) / rounds);
    previous = stats;
  }
  const last = heapStats();
  perWindow.sort((left, right) => left - right);
  const grownTypes = Object.entries(last.objectTypeCounts)
    .map(([type, count]) => [type, count - (first.objectTypeCounts[type] ?? 0)] as const)
    .filter(([, grown]) => grown > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10);
  return { perRound: perWindow[1] ?? 0, perWindow, grownTypes };
}

/**
 * Counts how many of the sampled objects are still alive after a collection.
 * Use it for one object a round creates and must release, such as a node.
 */
export function liveSample(): {
  readonly track: (value: object) => void;
  readonly alive: () => Promise<number>;
} {
  const refs: Array<WeakRef<object>> = [];
  return {
    track: (value) => {
      refs.push(new WeakRef(value));
    },
    alive: async () => {
      await collectGarbage();
      return refs.filter((ref) => ref.deref() !== undefined).length;
    },
  };
}
