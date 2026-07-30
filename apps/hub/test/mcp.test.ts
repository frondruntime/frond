import { afterEach, describe, expect, test } from "bun:test";
import { Args, createRuntime } from "@frondruntime/core";
import type { AttachmentInfo, EncodedEventRecord, HubCommand } from "@frondruntime/devtools";
import { HUB_PROTOCOL_VERSION } from "@frondruntime/devtools";
import { Effect, Queue } from "effect";
import {
  clampLimit,
  coverageOf,
  page,
  type Row,
  resolve,
  rows,
  summarize,
} from "../src/mcpReads.ts";
import { AttachmentsNode } from "../src/nodes/attachments.ts";
import { EventRing } from "../src/retention.ts";

const SELF_INSTANCE_ID = "hub-self";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) {
    await teardown.pop()?.();
  }
});

type Harness = {
  readonly attach: (name: string, options?: { readonly self?: boolean }) => Promise<string>;
  readonly ingest: (
    attachmentId: string,
    records: ReadonlyArray<EncodedEventRecord>,
    droppedSince?: number
  ) => Promise<void>;
  readonly attachments: () => AttachmentsNode;
};

/**
 * The attachments node with nothing in front of it.
 *
 * Same shape as the dashboard harness and for the same reason: the socket has
 * its own tests, and what is under test here is a set of pure decisions over
 * whatever that socket produced.
 */
async function harness(): Promise<Harness> {
  const runtime = createRuntime();
  await runtime.submit({ _tag: "RuntimeStart" });

  teardown.push(async () => {
    await runtime.submit({ _tag: "RuntimeStop", reason: "test teardown" });
  });

  const attachments = await runtime.client.node(AttachmentsNode, Args.none).ensureReadyNode();

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
    ingest: (attachmentId, records, droppedSince = 0) =>
      Effect.runPromise(attachments.ingested(attachmentId, records, droppedSince)),
    attachments: () => attachments,
  };
}

function info(name: string, self: boolean): AttachmentInfo {
  return {
    protocolVersion: HUB_PROTOCOL_VERSION,
    instanceId: self ? SELF_INSTANCE_ID : `instance-${name}`,
    // Shared by every attachment on purpose. It is a per-process counter, so
    // the hub and the app it is watching both report `runtime-1` — anything
    // here that decides identity on it will pass its own tests and be wrong.
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

/**
 * The one attached row, asserted rather than optional-chained.
 *
 * `noUncheckedIndexedAccess` turns every `[0]` into a maybe, and threading that
 * through each assertion buries what is under test beneath `?.`. Throwing on the
 * wrong count also catches a harness that attached more than the test meant to.
 */
function only(hub: Harness): Row {
  const found = rows(hub.attachments());
  const row = found[0];

  if (row === undefined || found.length !== 1) {
    throw new Error(`expected exactly one attachment, found ${found.length}`);
  }

  return row;
}

/**
 * Runs a resolution to one side or the other.
 *
 * The message is half of what {@link resolve} produces — an ambiguity that says
 * only "pass an id" costs the caller a round trip it did not have to spend — so
 * the failures are asserted on as closely as the successes.
 */
function attempt(
  hub: Harness,
  attachmentId?: string
): { readonly ok: string } | { readonly error: string } {
  return Effect.runSync(
    resolve(hub.attachments(), SELF_INSTANCE_ID, attachmentId).pipe(
      Effect.match({
        onSuccess: ([view]) => ({ ok: view.attachmentId }) as const,
        onFailure: (error) => ({ error: error.message }) as const,
      })
    )
  );
}

describe("resolve", () => {
  test("a sole attached app is used without being named", async () => {
    const hub = await harness();
    const app = await hub.attach("app");

    expect(attempt(hub)).toEqual({ ok: app });
  });

  /**
   * The rule this file exists for. The hub attaches to its own runtime, so on an
   * otherwise idle machine it is the only candidate — and answering "what does
   * my graph look like" with the devtools' own graph is a wrong answer wearing
   * the shape of a right one.
   */
  test("the hub's own attachment is never the default", async () => {
    const hub = await harness();

    await hub.attach("frond-hub", { self: true });
    const app = await hub.attach("app");

    expect(attempt(hub)).toEqual({ ok: app });
  });

  test("the hub still resolves when it is named explicitly", async () => {
    const hub = await harness();
    const self = await hub.attach("frond-hub", { self: true });

    expect(attempt(hub, self)).toEqual({ ok: self });
  });

  test("a hub-only list says how to attach an app and how to read the hub", async () => {
    const hub = await harness();
    const self = await hub.attach("frond-hub", { self: true });
    const outcome = attempt(hub);

    expect(outcome).toHaveProperty("error");
    expect("error" in outcome ? outcome.error : "").toContain("attachDevtools");
    // The escape hatch has to carry the id, or the advice is unfollowable.
    expect("error" in outcome ? outcome.error : "").toContain(self);
  });

  test("an empty hub says nothing is attached rather than naming candidates", async () => {
    const hub = await harness();
    const outcome = attempt(hub);

    expect("error" in outcome ? outcome.error : "").toContain(
      "No runtimes are attached to this hub"
    );
  });

  /**
   * The hub is left out of an ambiguity list because it is not one of the
   * things the caller is choosing between — including it would offer the tool
   * as an answer to a question about the program.
   */
  test("two apps are ambiguous, and the list is the apps only", async () => {
    const hub = await harness();

    await hub.attach("frond-hub", { self: true });
    await hub.attach("first");
    await hub.attach("second");

    const outcome = attempt(hub);
    const message = "error" in outcome ? outcome.error : "";

    expect(message).toContain("att-first");
    expect(message).toContain("att-second");
    expect(message).not.toContain("att-frond-hub");
  });

  test("an unknown id lists the candidates, marking which one is the hub", async () => {
    const hub = await harness();

    await hub.attach("frond-hub", { self: true });
    await hub.attach("app");

    const outcome = attempt(hub, "att-nope");
    const message = "error" in outcome ? outcome.error : "";

    expect(message).toContain("No attachment att-nope");
    expect(message).toContain("att-app");
    expect(message).toContain("this hub");
  });
});

describe("summarize", () => {
  /**
   * `instanceId`, not `runtimeId`. Both attachments here report `runtime-1`, so
   * a comparison on that would mark every row as the hub.
   */
  test("only the hub's own attachment is flagged as the hub", async () => {
    const hub = await harness();

    await hub.attach("frond-hub", { self: true });
    await hub.attach("app");

    const summaries = rows(hub.attachments()).map(([view, ring]) =>
      summarize(view, ring, SELF_INSTANCE_ID)
    );

    expect(summaries.map((row) => [row.name, row.isHub])).toEqual([
      ["frond-hub", true],
      ["app", false],
    ]);
  });

  test("an attachment that has seen no events reports no last tag at all", async () => {
    const hub = await harness();

    await hub.attach("app");

    const [view, ring] = only(hub);
    const summary = summarize(view, ring, SELF_INSTANCE_ID);

    // `not.toHaveProperty`, not `toBeUndefined`: the schema marks it optional,
    // and a key that is present and undefined encodes as null on the wire.
    expect(summary).not.toHaveProperty("lastTag");
    expect(summary.eventCount).toBe(0);
  });

  test("ingested events show up in the count, the tag and the coverage", async () => {
    const hub = await harness();
    const app = await hub.attach("app");

    await hub.ingest(app, [record({ tag: "GraphActionFailed" })], 3);

    const [view, ring] = only(hub);
    const summary = summarize(view, ring, SELF_INSTANCE_ID);

    expect(summary.eventCount).toBe(1);
    expect(summary.lastTag).toBe("GraphActionFailed");
    expect(summary.coverage.retainedCount).toBe(1);
    expect(summary.coverage.droppedBySender).toBe(3);
    expect(summary.coverage.evictedByHub).toBe(0);
  });
});

describe("clampLimit", () => {
  test("an unspecified limit is the default page", () => {
    expect(clampLimit(undefined)).toBe(50);
  });

  /**
   * Clamped rather than rejected: an over-large limit is a caller guessing at a
   * ceiling nobody told it, and `hasMore` already reports that the answer was
   * cut short.
   */
  test("an over-large limit is clamped instead of failing", () => {
    expect(clampLimit(10_000)).toBe(200);
  });

  test("a limit at or below zero still returns one record", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });

  test("a fractional limit is truncated", () => {
    expect(clampLimit(7.9)).toBe(7);
  });
});

describe("coverageOf", () => {
  /**
   * The two counters mean different things: `droppedBySender` never reached the
   * hub, `evictedByHub` did and has since aged out. Only the second is avoidable
   * by reading sooner, so conflating them sends the reader after the wrong fix.
   */
  test("the two gap counters come from different places", async () => {
    const hub = await harness();
    const app = await hub.attach("app");

    await hub.ingest(app, [record()], 7);

    const [view, ring] = only(hub);
    const coverage = coverageOf(view, ring);

    expect(coverage.droppedBySender).toBe(7);
    expect(coverage.evictedByHub).toBe(0);
  });

  test("an empty ring reports no sequence range rather than a zero one", async () => {
    const hub = await harness();

    await hub.attach("app");

    const [view, ring] = only(hub);
    const coverage = coverageOf(view, ring);

    // Zero is a real sequence. Claiming one the hub does not hold would let a
    // reader line this up against events that never arrived.
    expect(coverage).not.toHaveProperty("oldestRetainedSequence");
    expect(coverage).not.toHaveProperty("newestSequence");
    expect(coverage.retainedCount).toBe(0);
  });

  test("a missing ring is reported as holding nothing, not as an error", async () => {
    const hub = await harness();

    await hub.attach("app");

    const [view] = only(hub);
    const coverage = coverageOf(view, undefined);

    expect(coverage.retainedCount).toBe(0);
    expect(coverage.evictedByHub).toBe(0);
  });
});

describe("page", () => {
  /**
   * The view and the ring are two writes, so a read can land between them. An
   * empty page is the honest answer — there is genuinely nothing retained yet —
   * and an error here would turn a race into a failed tool call.
   */
  test("an attachment with no ring pages as empty rather than failing", async () => {
    const hub = await harness();

    await hub.attach("app");

    const [view] = only(hub);
    const result = page(view, undefined, { limit: 50 });

    expect(result.records).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result).not.toHaveProperty("nextSince");
  });

  test("nextSince is the last record on the page, so paging resumes after it", async () => {
    const hub = await harness();
    const app = await hub.attach("app");
    const batch = [record(), record(), record()];
    const sequences = batch.map((row) => row.sequence);

    await hub.ingest(app, batch);

    const [view, ring] = only(hub);
    const first = page(view, ring, { limit: 2 });

    expect(first.records.map((row) => row.sequence)).toEqual(sequences.slice(0, 2));
    expect(first.hasMore).toBe(true);
    expect(first.nextSince).toBe(sequences[1]);

    const second = page(view, ring, { limit: 2, since: first.nextSince });

    expect(second.records.map((row) => row.sequence)).toEqual(sequences.slice(2));
    expect(second.hasMore).toBe(false);
  });

  /**
   * The signal to keep the cursor rather than reset it. A page that came back
   * empty because the filter matched nothing must not tell the caller to start
   * over from the oldest record.
   */
  test("an empty page carries no cursor", async () => {
    const hub = await harness();
    const app = await hub.attach("app");

    await hub.ingest(app, [record()]);

    const [view, ring] = only(hub);
    const result = page(view, ring, { limit: 50, tag: "NothingMatchesThis" });

    expect(result.records).toEqual([]);
    expect(result).not.toHaveProperty("nextSince");
  });

  /**
   * The signal filters as `frond_read_events` hands them down. They are worth a
   * test at this level because the tool's contract is that they are enough on
   * their own: only a signal record carries a channel, so narrowing to one bus
   * does not also require naming the category.
   */
  test("a page narrows to one signal channel, and to one message across channels", async () => {
    const hub = await harness();
    const app = await hub.attach("app");
    const signal = (channel: string, name: string): EncodedEventRecord =>
      record({ tag: "RuntimeSignalPublished", category: "signal", channel, name });

    await hub.ingest(app, [
      signal("app.analytics", "checkout_started"),
      signal("app.analytics", "cart_cleared"),
      signal("app.sync", "checkout_started"),
      record(),
    ]);

    const [view, ring] = only(hub);

    expect(
      page(view, ring, { limit: 50, channel: "app.analytics" }).records.map((r) => r.name)
    ).toEqual(["checkout_started", "cart_cleared"]);
    expect(
      page(view, ring, { limit: 50, name: "checkout_started" }).records.map((r) => r.channel)
    ).toEqual(["app.analytics", "app.sync"]);
  });

  /**
   * The counter an agent reads to tell "nothing happened between sequence 5 and
   * sequence 900" from "the hub threw that away". The node's own ring is sized
   * for production, so this drives one small enough to actually overflow.
   */
  test("eviction is reported on the page the reader is holding", async () => {
    const hub = await harness();

    await hub.attach("app");

    const ring = new EventRing(1);
    ring.push(Array.from({ length: 600 }, () => record()));

    const [view] = only(hub);
    const result = page(view, ring, { limit: 50 });

    expect(result.coverage.evictedByHub).toBeGreaterThan(0);
    expect(result.coverage.retainedCount).toBe(ring.size);
    expect(result.coverage.oldestRetainedSequence).toBe(ring.oldestRetainedSequence as number);
  });
});
