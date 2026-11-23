import { expect, test } from "bun:test";
import { leakSlackPerRound, liveSample, objectGrowth } from "./leakTestFixtures";

// The leak checks are only as good as these two controls: a round that keeps
// an object must fail the check, and one that keeps nothing must pass it.

const retained: Array<unknown> = [];

test("the leak check fails a round that keeps an object", async () => {
  const growth = await objectGrowth(() => {
    retained.push({ rows: [1, 2, 3] });
  });
  retained.length = 0;

  expect(growth.perRound).toBeGreaterThan(leakSlackPerRound);
});

test("the leak check passes a round that keeps nothing", async () => {
  const growth = await objectGrowth(() => ({ rows: [1, 2, 3], index: new Map([[1, {}]]) }));

  expect(growth.perRound).toBeLessThan(leakSlackPerRound);
});

test("a live sample counts the tracked objects still reachable", async () => {
  const sample = liveSample();
  const kept: Array<object> = [];
  for (let index = 0; index < 20; index += 1) {
    const value = { index };
    sample.track(value);
    if (index < 5) kept.push(value);
  }

  expect(await sample.alive()).toBeLessThanOrEqual(6);
  expect(await sample.alive()).toBeGreaterThanOrEqual(5);
  expect(kept.length).toBe(5);
});
