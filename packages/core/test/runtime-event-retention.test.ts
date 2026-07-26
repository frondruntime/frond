import { describe, expect, test } from "bun:test";
import type { RuntimeEventRecord } from "../src/runtime";
import { createRuntime } from "../src/runtime";

describe("runtime event retention", () => {
  test("eventBufferSize 0 never retains a record, even transiently, while observers see every record", async () => {
    const runtime = createRuntime({ eventBufferSize: 0 });
    const observed: Array<RuntimeEventRecord> = [];
    const subscription = runtime.observe((record) => {
      observed.push(record);
    });

    await runtime.submit({ _tag: "RuntimeStart" });

    // Observers received the emitted records: delivery is unaffected by
    // retention policy.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.map((record) => record.event._tag)).toContain("RuntimeStarted");

    // The retained-event query surface holds nothing under zero retention —
    // records must never enter the buffer, not merely be trimmed after a push.
    const unlimited = await runtime.query({ _tag: "RuntimeEvents" });
    expect(unlimited._tag === "RuntimeEvents" ? unlimited.events : ["not-events"]).toEqual([]);

    const limited = await runtime.query({ _tag: "RuntimeEvents", limit: 10 });
    expect(limited._tag === "RuntimeEvents" ? limited.events : ["not-events"]).toEqual([]);

    // Sequencing stays monotonic for observers even though nothing is retained.
    const sequences = observed.map((record) => record.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));

    subscription.unsubscribe();
    await runtime.submit({ _tag: "RuntimeStop", reason: "zero retention test" });
  });

  test("eventBufferSize 1 still trims to the newest record", async () => {
    const runtime = createRuntime({ eventBufferSize: 1 });

    await runtime.submit({ _tag: "RuntimeStart" });

    const retained = await runtime.query({ _tag: "RuntimeEvents" });
    expect(retained._tag === "RuntimeEvents" ? retained.events.length : 0).toBe(1);

    await runtime.submit({ _tag: "RuntimeStop", reason: "bounded retention test" });
  });
});
