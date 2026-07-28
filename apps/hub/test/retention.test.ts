import { describe, expect, test } from "bun:test";
import type { EncodedEventRecord } from "@frondruntime/devtools";
import { EventRing } from "../src/retention.ts";

function record(sequence: number, overrides: Partial<EncodedEventRecord> = {}): EncodedEventRecord {
  return {
    sequence,
    recordedAt: 1000 + sequence,
    tag: "GraphNodeChanged",
    category: "state",
    severity: "info",
    timeline: "state",
    reportable: true,
    workId: 1,
    source: "manual",
    reason: "acquire",
    priority: "background",
    nodeIds: [],
    fields: {},
    failures: [],
    ...overrides,
  } as EncodedEventRecord;
}

function fill(ring: EventRing, count: number, from = 1): void {
  ring.push(Array.from({ length: count }, (_, index) => record(from + index)));
}

describe("EventRing", () => {
  test("reads back what it was given, oldest first", () => {
    const ring = new EventRing(10);
    fill(ring, 3);

    const window = ring.read({ limit: 10 });

    expect(window.records.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(window.hasMore).toBe(false);
    expect(window.oldestRetainedSequence).toBe(1);
    expect(window.evictedCount).toBe(0);
  });

  test("since is exclusive, so paging with the last sequence does not repeat it", () => {
    const ring = new EventRing(10);
    fill(ring, 5);

    expect(ring.read({ since: 3, limit: 10 }).records.map((row) => row.sequence)).toEqual([4, 5]);
  });

  test("hasMore says the page was cut short rather than exhausted", () => {
    const ring = new EventRing(10);
    fill(ring, 5);

    const page = ring.read({ limit: 2 });

    expect(page.records.map((row) => row.sequence)).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
    expect(ring.read({ since: 5, limit: 2 }).hasMore).toBe(false);
  });

  /**
   * The reason eviction is counted rather than inferred: a reader that asks for
   * everything since sequence 1 and gets records starting at 600 must be able to
   * tell that the hub aged them out. Silence there reads as "nothing happened",
   * which is the one answer a devtools feed must never give.
   */
  test("evicting the oldest records is reported, not silent", () => {
    const ring = new EventRing(100);

    fill(ring, 2000);

    const window = ring.read({ limit: 5 });

    expect(ring.size).toBeLessThanOrEqual(100 + 512);
    expect(window.evictedCount).toBe(2000 - ring.size);
    expect(window.oldestRetainedSequence).toBe(2000 - ring.size + 1);
    // Every record is still accounted for: kept plus evicted is what arrived.
    expect(ring.size + window.evictedCount).toBe(2000);
  });

  test("a since older than anything retained returns the oldest it still has", () => {
    const ring = new EventRing(100);
    fill(ring, 2000);

    const window = ring.read({ since: 1, limit: 3 });
    const oldest = window.oldestRetainedSequence;

    expect(oldest).toBeGreaterThan(1);
    expect(window.records[0]?.sequence).toBe(oldest as number);
  });

  test("filters combine with AND and match exactly", () => {
    const ring = new EventRing(10);

    ring.push([
      record(1, { tag: "GraphNodeChanged", workId: 7 }),
      record(2, { tag: "GraphActionFailed", workId: 7 }),
      record(3, { tag: "GraphActionFailed", workId: 8 }),
    ]);

    expect(
      ring.read({ tag: "GraphActionFailed", workId: 7, limit: 10 }).records.map((r) => r.sequence)
    ).toEqual([2]);
  });

  test("nodeId matches a record that lists it among several", () => {
    const ring = new EventRing(10);

    ring.push([
      record(1, { nodeIds: ["hub/config:v1", "hub/server:v1"] }),
      record(2, { nodeIds: ["hub/attachments:v1"] }),
    ]);

    expect(
      ring.read({ nodeId: "hub/server:v1", limit: 10 }).records.map((r) => r.sequence)
    ).toEqual([1]);
  });

  test("an empty ring reports no coverage rather than a fake zero", () => {
    const window = new EventRing(10).read({ limit: 10 });

    expect(window.records).toEqual([]);
    expect(window.oldestRetainedSequence).toBeUndefined();
    expect(window.hasMore).toBe(false);
  });
});
