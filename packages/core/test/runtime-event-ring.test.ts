import { describe, expect, test } from "bun:test";
import { createRuntime, type RuntimeEventRecord } from "../src/runtime";

describe("runtime event ring parity", () => {
  for (const capacity of [1, 3, 512]) {
    test(`capacity ${capacity} preserves records, order, sequences, and query limits across wraparound`, async () => {
      const runtime = createRuntime({ development: true, eventBufferSize: capacity });
      const observed: Array<RuntimeEventRecord> = [];
      const subscription = runtime.observe((record) => observed.push(record));
      const checkpoints = new Set([
        0,
        1,
        capacity - 1,
        capacity,
        capacity + 1,
        capacity * 2,
        capacity * 2 + 1,
        1100,
      ]);
      const snapshots: Array<{
        readonly records: ReadonlyArray<RuntimeEventRecord>;
        readonly expected: ReadonlyArray<RuntimeEventRecord>;
      }> = [];

      try {
        for (let emitted = 0; emitted <= 1100; emitted += 1) {
          if (emitted > 0) {
            await runtime.control({ _tag: "SetInputIngestion", enabled: emitted % 2 === 0 });
          }
          if (!checkpoints.has(emitted)) continue;

          const expected = observed.slice(-capacity);
          for (const limit of [undefined, 0, 1, capacity - 1, capacity, capacity + 1]) {
            const query = await runtime.query({ _tag: "RuntimeEvents", limit });
            if (query._tag !== "RuntimeEvents") {
              throw new Error(`Expected runtime events, received ${query._tag}`);
            }
            const limited =
              limit === undefined ? expected : limit === 0 ? [] : expected.slice(-limit);
            expect(query.events).toEqual(limited);
            expect(query.events.map((record) => record.sequence)).toEqual(
              limited.map((record) => record.sequence)
            );
            for (const [index, record] of query.events.entries()) {
              expect(record).toBe(limited[index]);
            }
            snapshots.push({ records: query.events, expected: [...limited] });
          }
        }

        expect(observed).toHaveLength(1100);
        expect(observed.map((record) => record.sequence)).toEqual(
          Array.from({ length: 1100 }, (_, index) => index + 1)
        );
        for (const snapshot of snapshots) {
          expect(snapshot.records).toEqual(snapshot.expected);
        }
      } finally {
        subscription.unsubscribe();
        await runtime.submit({ _tag: "RuntimeStop", reason: "event ring parity test" });
      }
    });
  }
});
