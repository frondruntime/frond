import { afterEach, expect, test } from "bun:test";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "../src";
import { leakSlackPerRound, liveSample, objectGrowth } from "./leakTestFixtures";

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

type Row = { id: number; v: number; tags: Array<string> };

type BoardSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly id: number };
  readonly key: Key.Structure<{ readonly id: number }>;
  readonly deps: Record<string, never>;
  readonly result: { rows: Array<Row> };
  readonly actions: { readonly patchRow: ActionContract; readonly spreadRows: ActionContract };
}>;

class BoardNode extends NodeBase<BoardSpec> {
  static readonly spec = resourceSpec.async<BoardSpec>({
    tag: tag("test/core/leak-evict/board"),
    key: ({ id }) => Key.structure({ id }),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => ({
      rows: Array.from({ length: 10 }, (_, id) => ({ id, v: 0, tags: ["a"] })),
    })),
    actions: {
      patchRow: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          const row = current.rows[0];
          if (row !== undefined) row.v += 1;
        });
      }),
      spreadRows: Driver.Action((ctx) => {
        ctx.setResult((current) => ({ rows: [...current.rows, { id: 99, v: 0, tags: [] }] }));
      }),
    },
  });
}

async function started() {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  return runtime;
}

test("a node written to and then evicted leaves nothing behind", async () => {
  const runtime = await started();
  const nodes = liveSample();
  const round = async (index: number, track: boolean) => {
    const handle = runtime.client.node(BoardNode, { id: index });
    await handle.ensureReady();
    if ((await handle.actions.patchRow())._tag !== "Success") throw new Error("patch failed");
    if ((await handle.actions.spreadRows())._tag !== "Success") throw new Error("spread failed");
    const ready = handle.read();
    if (ready._tag !== "Ready") throw new Error("node not ready");
    if (track) nodes.track(ready.node);
    await handle.evict("selfAndDependents", "leak check");
  };
  const growth = await objectGrowth((index) => round(index, false));
  for (let index = 0; index < 20; index += 1) await round(10_000 + index, true);

  expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
  expect(await nodes.alive()).toBeLessThanOrEqual(2);
});
