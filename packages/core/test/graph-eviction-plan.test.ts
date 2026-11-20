import { describe, expect, test } from "bun:test";
import { evictionPlan, removePlannedEdges } from "../src/graph/lifecycle/evictionPlan";
import type { EdgeSnapshot, EvictMode, NodeId } from "../src/graph/types";

const id = (name: string) => name as NodeId;

/** Edges as `dependent>dependency:slot` strings, keyed as planning keys them. */
function edges(...specs: ReadonlyArray<string>): Map<string, EdgeSnapshot> {
  const map = new Map<string, EdgeSnapshot>();
  for (const spec of specs) {
    const [from = "", rest = ""] = spec.split(">");
    const [to = "", dependency = to] = rest.split(":");
    map.set(`${from}:${dependency}`, { from: id(from), to: id(to), dependency });
  }
  return map;
}

function nodes(...names: ReadonlyArray<string>): ReadonlyMap<NodeId, unknown> {
  return new Map(names.map((name) => [id(name), name]));
}

/**
 * The order as it was computed before the linear plan: a breadth-first
 * closure over a map of dependents, one breadth-first depth pass per node,
 * and a stable sort, deepest first.
 */
function referenceOrder(
  graphNodes: ReadonlyMap<NodeId, unknown>,
  graphEdges: ReadonlyMap<string, EdgeSnapshot>,
  roots: ReadonlyArray<NodeId>,
  mode: EvictMode
): ReadonlyArray<NodeId> {
  const dependents = new Map<NodeId, Array<NodeId>>();
  for (const edge of graphEdges.values()) {
    const list = dependents.get(edge.to) ?? [];
    list.push(edge.from);
    dependents.set(edge.to, list);
  }
  const closure = new Set<NodeId>(roots.filter((root) => graphNodes.has(root)));
  const queue = [...roots];
  for (let head = 0; head < queue.length; head += 1) {
    for (const dependent of dependents.get(queue[head] as NodeId) ?? []) {
      if (!closure.has(dependent)) {
        closure.add(dependent);
        queue.push(dependent);
      }
    }
  }
  if (mode === "dependents") {
    for (const root of roots) {
      closure.delete(root);
    }
  }
  const depth = new Map<NodeId, number>();
  for (const nodeId of closure) {
    const distance = new Map<NodeId, number>([[nodeId, 0]]);
    const pass = [nodeId];
    for (let head = 0; head < pass.length; head += 1) {
      const node = pass[head] as NodeId;
      for (const dependent of dependents.get(node) ?? []) {
        if (!distance.has(dependent)) {
          distance.set(dependent, (distance.get(node) ?? 0) + 1);
          pass.push(dependent);
        }
      }
    }
    depth.set(nodeId, Math.max(...distance.values()));
  }
  return [...closure].sort((left, right) => (depth.get(right) ?? 0) - (depth.get(left) ?? 0));
}

describe("evictionPlan", () => {
  test("lists each evicted node's edges at both ends, once each", () => {
    const graph = edges("a>R", "b>R", "x>a", "y>b", "z>y", "z>b", "keep>R");
    const plan = evictionPlan(
      { nodes: nodes("R", "a", "b", "x", "y", "z", "keep"), edges: graph },
      { rootNodeIds: [id("b")], mode: "selfAndDependents" }
    );

    expect(plan.nodeIds).toEqual([id("b"), id("y"), id("z")]);
    const keysOf = (index: number) =>
      plan.edgeKeys.slice(plan.edgeKeyStart[index], plan.edgeKeyStart[index + 1]);
    expect(keysOf(0)).toEqual(["b:R", "y:b", "z:b"]);
    expect(keysOf(1)).toEqual(["y:b", "z:y"]);
    expect(keysOf(2)).toEqual(["z:y", "z:b"]);

    removePlannedEdges(graph, plan, 2);
    expect([...graph.keys()]).toEqual(["a:R", "b:R", "x:a", "y:b", "keep:R"]);
    removePlannedEdges(graph, plan, 0);
    removePlannedEdges(graph, plan, 1);
    expect([...graph.keys()]).toEqual(["a:R", "x:a", "keep:R"]);
  });

  test("measures a dependent's depth through a retained root", () => {
    const roots = [id("R"), id("r")];
    // x reaches z only through the retained root r: depth 2, ahead of w at
    // depth 1. The second graph adds u, so an edge of w skips a level.
    const cases = [
      {
        graphNodes: nodes("R", "r", "w", "x", "z", "v"),
        graphEdges: edges("w>R", "x>R", "v>w", "r>x", "z>r"),
        expected: ["x", "w", "z", "v"],
      },
      {
        graphNodes: nodes("R", "r", "w", "x", "z", "v", "u"),
        graphEdges: edges("w>R", "x>R", "v>w", "u>w", "r>x", "z>r", "v>u"),
        expected: ["x", "w", "u", "z", "v"],
      },
    ];
    for (const { graphNodes, graphEdges, expected } of cases) {
      const plan = evictionPlan(
        { nodes: graphNodes, edges: graphEdges },
        { rootNodeIds: roots, mode: "dependents" }
      );

      expect(plan.nodeIds).toEqual(expected.map(id));
      expect(plan.nodeIds).toEqual(referenceOrder(graphNodes, graphEdges, roots, "dependents"));
    }
  });

  test("reports the one dependent of many retained roots", () => {
    const names = Array.from({ length: 10_000 }, (_, index) => `n${index}`);
    const graphNodes = nodes(...names);
    // Each node depends on the two before it: edges skip a level.
    const graphEdges = edges(
      ...names.flatMap((name, index) =>
        index < 2 ? [] : [`${name}>n${index - 1}:a`, `${name}>n${index - 2}:b`]
      )
    );
    const roots = names.slice(0, -1).map(id);

    const plan = evictionPlan(
      { nodes: graphNodes, edges: graphEdges },
      { rootNodeIds: roots, mode: "dependents" }
    );

    expect(plan.nodeIds).toEqual([id("n9999")]);
    expect(plan.nodeIds).toEqual(referenceOrder(graphNodes, graphEdges, roots, "dependents"));
  });

  test("matches the per-node breadth-first order on seeded random graphs", () => {
    let seed = 7;
    const random = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    let layered = 0;
    for (let run = 0; run < 3000; run += 1) {
      const count = 1 + random(12);
      const names = Array.from({ length: count }, (_, index) => `n${index}`);
      const level = names.map(() => random(4));
      // 0: acyclic with edges that skip levels; 1: every edge drops one
      // level; 2: anything, cycles and self edges included.
      const shape = random(3);
      layered += shape === 1 ? 1 : 0;
      const graphNodes = new Map<NodeId, unknown>();
      for (const name of names) {
        if (random(20) !== 0) {
          graphNodes.set(id(name), name);
        }
      }
      const graphEdges = new Map<string, EdgeSnapshot>();
      for (let attempt = 0; attempt < count * 3; attempt += 1) {
        const from = random(count);
        const to = random(count);
        const allowed =
          shape === 0 ? from > to : shape === 1 ? level[from] === (level[to] as number) + 1 : true;
        if (allowed) {
          const dependency = `slot${random(3)}`;
          graphEdges.set(`${names[from]}:${dependency}`, {
            from: id(names[from] as string),
            to: id(names[to] as string),
            dependency,
          });
        }
      }
      const roots = Array.from({ length: 1 + random(3) }, () =>
        id(random(10) === 0 ? "missing" : (names[random(count)] as string))
      );
      const mode: EvictMode = random(2) === 0 ? "selfAndDependents" : "dependents";

      const plan = evictionPlan(
        { nodes: graphNodes, edges: graphEdges },
        { rootNodeIds: roots, mode }
      );

      expect(plan.nodeIds).toEqual(referenceOrder(graphNodes, graphEdges, roots, mode));
      for (let index = 0; index < plan.nodeIds.length; index += 1) {
        removePlannedEdges(graphEdges, plan, index);
      }
      for (const edge of graphEdges.values()) {
        expect(plan.nodeIds.includes(edge.from) || plan.nodeIds.includes(edge.to)).toBe(false);
      }
    }
    expect(layered).toBeGreaterThan(500);
  });
});
