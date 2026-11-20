import { describe, expect, test } from "bun:test";
import type { NodeId } from "../src/graph";
import type { NodeDescriptor } from "../src/index";
import {
  type Dep,
  Driver,
  dep,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

type TableArgs = { readonly name: string };
interface TableDeps {
  readonly [slot: string]: Dep<TableNodeClass>;
}
type TableSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: TableArgs;
  readonly key: Key.Structure<TableArgs>;
  readonly deps: TableDeps;
  readonly result: string;
}>;
interface TableNodeClass {
  readonly spec: NodeDescriptor<TableSpec, "effect">;
  new (): NodeBase<TableSpec>;
}

/**
 * A graph whose nodes are named; `table[name]` lists the nodes `name` depends
 * on, one dependency slot each, named after the node it points to. Planning
 * records edges in the order nodes are made ready, so `ready` fixes the edge
 * order the eviction order reads.
 */
function makeTableGraph(tag: string, table: Readonly<Record<string, ReadonlyArray<string>>>) {
  class TableNode extends NodeBase<TableSpec> {
    static readonly spec = serviceSpec.effect<TableSpec>({
      tag,
      key: (args) => Key.structure({ name: args.name }),
      dependencies: dependencies((args) => {
        const slots: Record<string, Dep<TableNodeClass>> = {};
        for (const name of table[args.name] ?? []) {
          slots[name] = dep(TableNode, { name });
        }
        return slots;
      }),
      acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.args.name)),
    });
  }
  const graph = makeInMemoryGraphSystem();
  const idOf = (name: string): NodeId =>
    graph.resolveNodeIdSync({ spec: TableNode, args: { name } });
  const nameById = new Map<NodeId, string>();
  for (const name of Object.keys(table)) {
    nameById.set(idOf(name), name);
  }
  const ready = async (...names: ReadonlyArray<string>): Promise<void> => {
    for (const name of names) {
      await Effect.runPromise(graph.ensureReadyNode({ spec: TableNode, args: { name } }));
    }
  };
  const evict = async (
    roots: ReadonlyArray<string>,
    mode: "selfAndDependents" | "dependents",
    extraRootNodeIds: ReadonlyArray<NodeId> = []
  ) => {
    const result = await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [...roots.map(idOf), ...extraRootNodeIds],
        mode,
        reason: "eviction order",
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    return {
      order: result.nodeIds.map((nodeId) => nameById.get(nodeId) ?? nodeId),
      nodes: snapshot.nodes.map((node) => nameById.get(node.nodeId) ?? node.nodeId).sort(),
      edges: snapshot.edges.map(
        (edge) => `${nameById.get(edge.from) ?? edge.from}>${nameById.get(edge.to) ?? edge.to}`
      ),
    };
  };
  return { ready, evict };
}

// The reported order is by dependency depth, deepest first: a node's depth is
// the largest of its shortest distances to each node that depends on it,
// directly or not. Equal depths keep the order the closure found them in,
// which follows the order planning recorded the edges in.
describe("eviction order", () => {
  test("a shortcut edge counts its shortest distance, not its longest path", async () => {
    // b reaches z directly and through y: depth 1, the same as a, so b stays
    // after a. A longest-path depth would put b (2) before a (1).
    const { ready, evict } = makeTableGraph("eviction-order/shortcut", {
      R: [],
      a: ["R"],
      b: ["R"],
      x: ["a"],
      y: ["b"],
      z: ["y", "b"],
    });
    await ready("x", "z");

    expect(await evict(["R"], "selfAndDependents")).toEqual({
      order: ["R", "a", "b", "y", "x", "z"],
      nodes: [],
      edges: [],
    });
  });

  test("equal depths keep the order planning recorded their edges in", async () => {
    const forward = makeTableGraph("eviction-order/tie-forward", {
      R: [],
      p: ["R"],
      q: ["R"],
      top: ["p", "q"],
    });
    const backward = makeTableGraph("eviction-order/tie-backward", {
      R: [],
      p: ["R"],
      q: ["R"],
      top: ["q", "p"],
    });
    await forward.ready("top");
    await backward.ready("top");

    expect((await forward.evict(["R"], "selfAndDependents")).order).toEqual(["R", "p", "q", "top"]);
    expect((await backward.evict(["R"], "selfAndDependents")).order).toEqual([
      "R",
      "q",
      "p",
      "top",
    ]);
  });

  test("several roots come first in request order, and a missing root is skipped", async () => {
    const { ready, evict } = makeTableGraph("eviction-order/roots", {
      m: [],
      n: [],
      u: ["m"],
      v: ["n"],
      w: ["m", "n"],
      other: [],
    });
    await ready("u", "v", "w", "other");

    expect(
      await evict(["m", "n"], "selfAndDependents", ["eviction-order/missing" as NodeId])
    ).toEqual({
      order: ["m", "n", "u", "w", "v"],
      nodes: ["other"],
      edges: [],
    });
  });

  test("dependents mode keeps the roots and drops every edge into them", async () => {
    const { ready, evict } = makeTableGraph("eviction-order/dependents", {
      R: [],
      a: ["R"],
      b: ["R"],
      x: ["a"],
      y: ["b"],
      z: ["y", "b"],
    });
    await ready("x", "z");

    expect(await evict(["R"], "dependents")).toEqual({
      order: ["a", "b", "y", "x", "z"],
      nodes: ["R"],
      edges: [],
    });
  });

  test("dependents mode drops a root that another root reaches", async () => {
    const { ready, evict } = makeTableGraph("eviction-order/dependents-roots", {
      R: [],
      a: ["R"],
      b: ["R"],
      x: ["a"],
      y: ["b"],
      z: ["y", "b"],
    });
    await ready("x", "z");

    expect(await evict(["R", "a"], "dependents")).toEqual({
      order: ["b", "y", "x", "z"],
      nodes: ["R", "a"],
      edges: ["a>R"],
    });
  });
});
