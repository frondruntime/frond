import { expect, test } from "bun:test";
// The job queue has no public entry; isolate its exceptional drain contract.
import { makeGraphJobQueue } from "../src/graph/queue/jobQueue";

test("one throwing graph job does not discard unrelated queued work", () => {
  const drains: Array<() => void> = [];
  const queue = makeGraphJobQueue((drain) => {
    drains.push(drain);
  });
  const failure = new Error("job failed");
  const completed: string[] = [];
  queue.post({
    run: () => {
      throw failure;
    },
  });
  queue.post({
    run: () => {
      completed.push("already queued");
    },
  });
  const firstDrain = drains.shift();
  if (firstDrain === undefined) throw new Error("no drain scheduled");
  try {
    firstDrain();
  } catch (cause) {
    if (cause !== failure) throw cause;
  }

  queue.post({
    run: () => {
      completed.push("posted after error");
    },
  });
  const recoveryDrain = drains.shift();
  if (recoveryDrain === undefined) throw new Error("no recovery drain scheduled");
  recoveryDrain();
  expect(completed).toEqual(["already queued", "posted after error"]);
});

test("a throw from the last queued job leaves the queue ready for the next post", () => {
  const drains: Array<() => void> = [];
  const queue = makeGraphJobQueue((drain) => {
    drains.push(drain);
  });
  const failure = new Error("job failed");
  const completed: string[] = [];
  queue.post({
    run: () => {
      throw failure;
    },
  });
  expect(() => drains.shift()?.()).toThrow(failure);
  expect(drains).toHaveLength(0);
  queue.post({
    run: () => {
      completed.push("posted after error");
    },
  });
  expect(drains).toHaveLength(1);
  drains.shift()?.();
  expect(completed).toEqual(["posted after error"]);
});
