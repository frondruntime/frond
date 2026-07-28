import { afterEach, describe, expect, test } from "bun:test";
import { Args, createRuntime } from "@frondruntime/core";
import type { AttachmentInfo, EncodedEventRecord, HubCommand } from "@frondruntime/devtools";
import { HUB_PROTOCOL_VERSION } from "@frondruntime/devtools";
import { Effect, Queue } from "effect";
import { AttachmentsNode, TAIL_LIMIT } from "../src/nodes/attachments.ts";
import { DashboardNode } from "../src/nodes/dashboard.ts";

const SELF_INSTANCE_ID = "hub-self";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) {
    await teardown.pop()?.();
  }
});

type Harness = {
  readonly attach: (name: string, options?: { readonly self?: boolean }) => Promise<string>;
  readonly detach: (attachmentId: string) => Promise<void>;
  readonly ingest: (
    attachmentId: string,
    records: ReadonlyArray<EncodedEventRecord>
  ) => Promise<void>;
  readonly dashboard: () => DashboardNode;
};

/**
 * Drives the nodes directly rather than through a socket.
 *
 * The transport already has its own tests; what is under test here is the
 * ordering, cursor and pause rules, and routing them through a real attachment
 * would only add timing to a set of assertions that are otherwise exact.
 */
async function harness(): Promise<Harness> {
  const runtime = createRuntime();
  await runtime.submit({ _tag: "RuntimeStart" });

  teardown.push(async () => {
    await runtime.submit({ _tag: "RuntimeStop", reason: "test teardown" });
  });

  const attachments = await runtime.client.node(AttachmentsNode, Args.none).ensureReadyNode();
  const dashboard = await runtime.client
    .node(DashboardNode, { selfInstanceId: SELF_INSTANCE_ID })
    .ensureReadyNode();

  let clock = 1_000;

  return {
    attach: async (name, options) => {
      const attachmentId = `att-${name}`;
      clock += 1;

      await Effect.runPromise(
        Effect.flatMap(Queue.unbounded<HubCommand>(), (outbound) =>
          attachments.attached(attachmentId, info(name, options?.self === true), clock, outbound)
        )
      );

      return attachmentId;
    },
    detach: (attachmentId) => Effect.runPromise(attachments.detached(attachmentId)),
    ingest: (attachmentId, records) =>
      Effect.runPromise(attachments.ingested(attachmentId, records, 0)),
    dashboard: () => dashboard,
  };
}

function info(name: string, self: boolean): AttachmentInfo {
  return {
    protocolVersion: HUB_PROTOCOL_VERSION,
    // The one field that identifies the hub's own attachment. Every other
    // runtime gets a distinct id, including `runtimeId`, which is shared on
    // purpose here: it is a per-process counter and must never decide this.
    instanceId: self ? SELF_INSTANCE_ID : `instance-${name}`,
    runtimeId: "runtime-1",
    generation: 1,
    name,
    platform: "bun",
    startedAt: 0,
    values: "shape",
  };
}

let nextSequence = 0;

function record(overrides: Partial<EncodedEventRecord> = {}): EncodedEventRecord {
  nextSequence += 1;

  return {
    sequence: nextSequence,
    recordedAt: 1_000 + nextSequence,
    tag: "GraphNodeChanged",
    category: "state",
    severity: "info",
    timeline: "state",
    reportable: true,
    workId: 1,
    source: "runtime",
    reason: "readiness",
    priority: "visible",
    nodeIds: ["cart:v1"],
    fields: {},
    failures: [],
    ...overrides,
  };
}

describe("dashboard rows", () => {
  test("rows are oldest first", async () => {
    const hub = await harness();

    await hub.attach("first");
    await hub.attach("second");

    expect(hub.dashboard().result.rows.map((row) => row.info.name)).toEqual(["first", "second"]);
  });

  /**
   * The hub is always attached and is never the thing being debugged. Left in
   * arrival order it is usually the oldest row, which makes it the one the
   * cursor lands on when a fresh hub has nothing else to show.
   */
  test("the hub's own attachment sinks to the bottom however early it attached", async () => {
    const hub = await harness();

    await hub.attach("frond-hub", { self: true });
    await hub.attach("app");

    expect(hub.dashboard().result.rows.map((row) => row.info.name)).toEqual(["app", "frond-hub"]);
  });

  test("isSelf recognises the hub and nothing else", async () => {
    const hub = await harness();

    await hub.attach("frond-hub", { self: true });
    await hub.attach("app");

    const { rows, isSelf } = hub.dashboard().result;

    expect(rows.map(isSelf)).toEqual([false, true]);
  });
});

describe("dashboard selection", () => {
  test("with nothing selected the cursor sits on the first row", async () => {
    const hub = await harness();

    await hub.attach("first");
    await hub.attach("second");

    expect(hub.dashboard().result.selected?.info.name).toBe("first");
  });

  test("selecting moves the cursor", async () => {
    const hub = await harness();

    await hub.attach("first");
    const second = await hub.attach("second");

    await hub.dashboard().selectionChanged(second);

    expect(hub.dashboard().result.selected?.info.name).toBe("second");
  });

  /**
   * An attachment can go away while the cursor is on it. A dashboard that
   * empties itself in response is less useful than one that moves to whatever
   * is still there.
   */
  test("the cursor falls back when the selected attachment detaches", async () => {
    const hub = await harness();

    await hub.attach("first");
    const second = await hub.attach("second");

    await hub.dashboard().selectionChanged(second);
    await hub.detach(second);

    expect(hub.dashboard().result.selected?.info.name).toBe("first");
  });

  test("an empty hub has no selection and an empty tail", async () => {
    const hub = await harness();

    expect(hub.dashboard().result.selected).toBeUndefined();
    expect(hub.dashboard().result.tail).toEqual([]);
  });
});

describe("dashboard tail", () => {
  test("the tail follows the selected attachment", async () => {
    const hub = await harness();

    const first = await hub.attach("first");
    const second = await hub.attach("second");

    await hub.ingest(first, [record({ tag: "First" })]);
    await hub.ingest(second, [record({ tag: "Second" })]);

    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["First"]);

    await hub.dashboard().selectionChanged(second);

    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["Second"]);
  });

  test("the tail is bounded and keeps the newest records", async () => {
    const hub = await harness();

    const app = await hub.attach("app");

    // One batch larger than the bound, so the naive "append then splice" would
    // keep the oldest records instead of the newest.
    await hub.ingest(
      app,
      Array.from({ length: TAIL_LIMIT + 20 }, () => record())
    );

    const tail = hub.dashboard().result.tail;
    const newest = tail.at(-1)?.sequence ?? 0;

    expect(tail).toHaveLength(TAIL_LIMIT);
    expect(tail[0]?.sequence).toBe(newest - TAIL_LIMIT + 1);
  });

  /**
   * Snapshotting is the whole point of pausing. Without it the tail keeps
   * rolling underneath a stopped cursor, and the records someone paused in
   * order to read are the first ones pushed off the end.
   */
  test("pausing freezes the tail and resuming catches up", async () => {
    const hub = await harness();

    const app = await hub.attach("app");

    await hub.ingest(app, [record({ tag: "Before" })]);
    await hub.dashboard().pauseChanged(true);
    await hub.ingest(app, [record({ tag: "During" })]);

    expect(hub.dashboard().result.paused).toBe(true);
    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["Before"]);

    await hub.dashboard().pauseChanged(false);

    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["Before", "During"]);
  });

  /**
   * The freeze is of one attachment's tail, so moving the cursor has to take a
   * new one. Otherwise the header names the attachment the cursor is on while
   * the list below it shows the events of the attachment the cursor left, with
   * nothing on screen to say the two disagree.
   */
  test("moving the cursor while paused freezes the tail it moved to", async () => {
    const hub = await harness();

    const alpha = await hub.attach("alpha");
    const bravo = await hub.attach("bravo");

    await hub.ingest(alpha, [record({ tag: "AlphaEvent" })]);
    await hub.ingest(bravo, [record({ tag: "BravoEvent" })]);

    await hub.dashboard().selectionChanged(alpha);
    await hub.dashboard().pauseChanged(true);

    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["AlphaEvent"]);

    await hub.dashboard().selectionChanged(bravo);

    expect(hub.dashboard().result.selected?.attachmentId).toBe(bravo);
    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["BravoEvent"]);
    // Still paused: moving the cursor re-snapshots, it does not resume.
    expect(hub.dashboard().result.paused).toBe(true);

    await hub.ingest(bravo, [record({ tag: "AfterPause" })]);

    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["BravoEvent"]);
  });
});

describe("dashboard filter", () => {
  test("filtering matches tags and node ids, case-insensitively", async () => {
    const hub = await harness();

    const app = await hub.attach("app");

    await hub.ingest(app, [
      record({ tag: "GraphActionFailed", nodeIds: ["cart:v1"] }),
      record({ tag: "GraphNodeChanged", nodeIds: ["checkout:v1"] }),
    ]);

    await hub.dashboard().filterChanged("failed");
    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["GraphActionFailed"]);

    await hub.dashboard().filterChanged("CHECKOUT");
    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["GraphNodeChanged"]);

    await hub.dashboard().filterChanged("");
    expect(hub.dashboard().result.tail).toHaveLength(2);
  });

  test("the filter applies to a paused snapshot too", async () => {
    const hub = await harness();

    const app = await hub.attach("app");

    await hub.ingest(app, [record({ tag: "Kept" }), record({ tag: "Dropped" })]);
    await hub.dashboard().pauseChanged(true);
    await hub.dashboard().filterChanged("kept");

    expect(hub.dashboard().result.tail.map((row) => row.tag)).toEqual(["Kept"]);
  });
});

describe("dashboard rate", () => {
  test("ingesting moves the selected row's rate window", async () => {
    const hub = await harness();

    const app = await hub.attach("app");

    await hub.ingest(app, [record(), record(), record()]);

    const rate = hub.dashboard().result.selected?.rate;

    expect(rate?.buckets.reduce((sum, value) => sum + value, 0)).toBe(3);
  });
});
