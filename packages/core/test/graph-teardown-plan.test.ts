import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runDependentsFirst, teardownPlan } from "../src/graph/lifecycle/teardownOrder";
import type { EdgeSnapshot, NodeId } from "../src/graph/types";

const id = (name: string) => name as NodeId;

/** Edges as `dependent>dependency:slot` strings, keyed as planning keys them. */
function edges(...specs: ReadonlyArray<string>): ReadonlyMap<string, EdgeSnapshot> {
  const map = new Map<string, EdgeSnapshot>();
  for (const spec of specs) {
    const [from = "", rest = ""] = spec.split(">");
    const [to = "", dependency = to] = rest.split(":");
    map.set(`${from}:${dependency}`, { from: id(from), to: id(to), dependency });
  }
  return map;
}

function orderNames(
  nodeIds: ReadonlyArray<string>,
  graph: ReadonlyMap<string, EdgeSnapshot>
): { readonly order: ReadonlyArray<string>; readonly placed: number } {
  const plan = teardownPlan(nodeIds.map(id), graph);
  return { order: Array.from(plan.order, (index) => nodeIds[index] ?? ""), placed: plan.placed };
}

describe("teardownPlan", () => {
  test("puts dependents before their dependencies by edge precedence", () => {
    const graph = edges(
      "quotes>venue",
      "chart>quotes",
      "chart>venue",
      "screen>chart",
      "screen>venue"
    );

    expect(orderNames(["quotes", "venue", "chart", "screen"], graph)).toEqual({
      order: ["screen", "chart", "quotes", "venue"],
      placed: 4,
    });
  });

  test("keeps independent nodes in input order", () => {
    expect(orderNames(["a", "b", "c"], edges())).toEqual({ order: ["a", "b", "c"], placed: 3 });
  });

  test("a dependent outside the set never blocks the order", () => {
    const graph = edges("outside>venue", "quotes>venue");

    expect(orderNames(["venue", "quotes"], graph)).toEqual({
      order: ["quotes", "venue"],
      placed: 2,
    });
  });

  test("two dependency slots naming one node count as two edges", () => {
    const graph = edges("screen>venue:primary", "screen>venue:fallback", "chart>venue");
    const plan = teardownPlan([id("venue"), id("screen"), id("chart")], graph);

    expect(Array.from(plan.dependents)).toEqual([3, 0, 0]);
    expect(orderNames(["venue", "screen", "chart"], graph).order).toEqual([
      "screen",
      "chart",
      "venue",
    ]);
  });

  test("a cycle's leftover nodes come last in input order instead of hanging", () => {
    const graph = edges("a>b", "b>a", "top>a", "a>leaf");

    expect(orderNames(["leaf", "a", "b", "top"], graph)).toEqual({
      order: ["top", "leaf", "a", "b"],
      placed: 1,
    });
  });

  test("an empty set has an empty order", () => {
    expect(orderNames([], edges("a>b"))).toEqual({ order: [], placed: 0 });
  });
});

describe("runDependentsFirst", () => {
  /** Runs each node for its delay in milliseconds and traces its start and end. */
  async function trace(
    nodes: ReadonlyArray<readonly [string, number]>,
    graph: ReadonlyMap<string, EdgeSnapshot>
  ) {
    const events: Array<string> = [];
    const plan = teardownPlan(
      nodes.map(([name]) => id(name)),
      graph
    );
    const results = await Effect.runPromise(
      runDependentsFirst(plan, (index) => {
        const [name, delay] = nodes[index] ?? ["", 0];
        return Effect.sync(() => events.push(`${name}:start`)).pipe(
          Effect.andThen(Effect.sleep(delay)),
          Effect.andThen(Effect.sync(() => events.push(`${name}:end`))),
          Effect.as(name)
        );
      })
    );
    return { events, results };
  }

  test("starts a node when its dependents finish, without waiting for unrelated nodes", async () => {
    const { events, results } = await trace(
      [
        ["slow", 40],
        ["venue", 0],
        ["quotes", 5],
      ],
      edges("quotes>venue")
    );

    expect(results).toEqual(["slow", "venue", "quotes"]);
    expect(events).toEqual([
      "slow:start",
      "quotes:start",
      "quotes:end",
      "venue:start",
      "venue:end",
      "slow:end",
    ]);
  });

  test("starts a dependency only after every dependent finishes", async () => {
    const { events } = await trace(
      [
        ["venue", 0],
        ["fast", 5],
        ["slow", 20],
      ],
      edges("fast>venue", "slow>venue")
    );

    expect(events).toEqual([
      "fast:start",
      "slow:start",
      "fast:end",
      "slow:end",
      "venue:start",
      "venue:end",
    ]);
  });

  test("starts a cycle's leftover nodes together after every placed node", async () => {
    const { events } = await trace(
      [
        ["a", 0],
        ["b", 0],
        ["top", 10],
        ["other", 20],
      ],
      edges("a>b", "b>a", "top>a")
    );

    expect(events).toEqual([
      "top:start",
      "other:start",
      "top:end",
      "other:end",
      "a:start",
      "b:start",
      "a:end",
      "b:end",
    ]);
  });
});
