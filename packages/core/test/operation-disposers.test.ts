import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeOperationDisposers } from "../src/graph/lifecycle/operationDisposers";
import type { GraphNodeCell } from "../src/graph/planning/plan";
import { DisposerFailed, type NodeId } from "../src/graph/types";

function makeBag() {
  const reported: Array<unknown> = [];
  const cell = {
    nodeId: "graph/test:v1:singleton" as NodeId,
    tag: "graph/test",
  } as unknown as GraphNodeCell;
  const bag = makeOperationDisposers(cell, (_nodeId, _reason, failures) =>
    Effect.sync(() => {
      reported.push(...failures);
    })
  );

  return { bag, reported };
}

describe("operation disposers", () => {
  test("interrupt drain after ready hand-off runs nothing and keeps the ready disposer set", async () => {
    const { bag } = makeBag();
    const runs: Array<string> = [];
    bag.add(() => runs.push("acquired"));

    const readyDisposers = bag.handOff();
    const failures = await Effect.runPromise(bag.drain("interrupt"));

    expect(failures).toEqual([]);
    expect(runs).toEqual([]);
    expect(readyDisposers).toHaveLength(1);

    for (const disposer of readyDisposers) {
      disposer();
    }

    expect(runs).toEqual(["acquired"]);
  });

  test("late adds after hand-off accumulate into the ready disposer set instead of running", () => {
    const { bag } = makeBag();
    const runs: Array<string> = [];

    const readyDisposers = bag.handOff();
    bag.add(() => runs.push("late"));

    expect(runs).toEqual([]);
    expect(readyDisposers).toHaveLength(1);
  });

  test("drain without hand-off runs collected disposers and settles late adds to run immediately", async () => {
    const { bag } = makeBag();
    const runs: Array<string> = [];
    bag.add(() => runs.push("collected"));

    const failures = await Effect.runPromise(bag.drain("interrupt"));

    expect(failures).toEqual([]);
    expect(runs).toEqual(["collected"]);

    bag.add(() => runs.push("late"));

    expect(runs).toEqual(["collected", "late"]);
  });

  test("take hands off a settled copy so a later interrupt drain cannot touch it", async () => {
    const { bag } = makeBag();
    const runs: Array<string> = [];
    bag.add(() => runs.push("operation"));

    const taken = bag.take("refresh");
    const failures = await Effect.runPromise(bag.drain("interrupt"));

    expect(failures).toEqual([]);
    expect(runs).toEqual([]);
    expect(taken).toHaveLength(1);
  });

  test("late disposer failures after settlement are reported", async () => {
    const { bag, reported } = makeBag();
    const failure = new Error("late disposer failed");

    const failures = await Effect.runPromise(bag.drain("interrupt"));
    bag.add(() => {
      throw failure;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failures).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(DisposerFailed);
    expect(reported[0]).toMatchObject({ cause: failure });
  });
});
