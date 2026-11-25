import { expect, test } from "bun:test";
import { autorun } from "mobx";
import {
  type ActionContract,
  createRuntime,
  Driver,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "../src";
import { leakSlackPerRound, liveSample, objectGrowth } from "./leakTestFixtures";

type Row = { id: number; v: number; tags: Array<string> };
const rows = (value: number): Array<Row> =>
  Array.from({ length: 50 }, (_, id) => ({ id, v: value, tags: ["a", "b"] }));

type BoardSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: { rows: Array<Row> };
  readonly actions: {
    readonly replace: ActionContract<number>;
    readonly shrink: ActionContract;
    readonly grow: ActionContract<number>;
    readonly patch: ActionContract;
  };
}>;

class BoardNode extends NodeBase<BoardSpec> {
  static readonly spec = resourceSpec.async<BoardSpec>({
    tag: tag("test/core/leak-result-churn/board"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => ({ rows: rows(0) })),
    actions: {
      replace: Driver.Action((context, value) => {
        context.setResult((current) => ({
          rows: current.rows.map((row, index) =>
            index === 3 ? { id: row.id, v: value, tags: ["replacement"] } : row
          ),
        }));
      }),
      shrink: Driver.Action((context) => {
        context.setResult((current) => ({ rows: current.rows.slice(0, 10) }));
      }),
      grow: Driver.Action((context, value) => {
        context.setResult((current) => ({
          rows: [...current.rows, ...rows(value).slice(current.rows.length)],
        }));
      }),
      patch: Driver.Action((context) => {
        context.patchResult((current) => {
          const row = current.rows[3];
          if (row === undefined) throw new Error("Row to patch is missing");
          row.v += 1;
          row.tags.push("patched");
        });
      }),
    },
  });
}

test("result churn releases removed live containers while one reader stays subscribed", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const containers = liveSample();
  let disposeReader = () => {};
  try {
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(BoardNode, {});
    if ((await handle.ensureReady())._tag !== "Ready") throw new Error("Node did not become ready");
    const node = handle.readReady();
    let observedTotal = 0;
    let observations = 0;
    disposeReader = autorun(() => {
      observedTotal = node.result.rows.reduce((total, row) => total + row.v, 0);
      observations += 1;
    });
    const round = async (index: number, track: boolean) => {
      const before = observations;
      if ((await handle.actions.replace(index))._tag !== "Success")
        throw new Error("Replace failed");
      if (node.result.rows[3]?.v !== index) throw new Error("Replacement did not commit");
      if (track) {
        const removed = node.result.rows[49];
        if (removed === undefined) throw new Error("Row to sample is missing");
        containers.track(removed);
        containers.track(removed.tags);
      }
      if ((await handle.actions.shrink())._tag !== "Success") throw new Error("Shrink failed");
      if (node.result.rows.length !== 10) throw new Error("Rows did not shrink");
      if ((await handle.actions.grow(index))._tag !== "Success") throw new Error("Grow failed");
      if (handle.readReady().result.rows.length !== 50) throw new Error("Rows did not grow");
      if ((await handle.actions.patch())._tag !== "Success") throw new Error("Patch failed");
      if (node.result.rows[3]?.v !== index + 1) throw new Error("Patch did not commit");
      const expectedTotal = node.result.rows.reduce((total, row) => total + row.v, 0);
      if (observations <= before || observedTotal !== expectedTotal)
        throw new Error("Reader did not observe the committed rows");
    };
    const growth = await objectGrowth((index) => round(index, false));
    for (let index = 0; index < 20; index += 1) await round(10_000 + index, true);
    console.info("L6 churn", JSON.stringify(growth));
    expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
    expect(await containers.alive()).toBeLessThanOrEqual(2);
  } finally {
    disposeReader();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 120_000);
