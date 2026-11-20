import { describe, expect, test } from "bun:test";
import type { Runtime } from "@frondruntime/core";
import { Effect, Fiber, Layer } from "effect";
import { RpcClient, type RpcMessage, RpcSerialization } from "effect/rpc";
import { attachRuntime } from "../src/attach.ts";

type Batch = {
  readonly records: ReadonlyArray<{ readonly sequence: number }>;
  readonly droppedSince: number;
};

/**
 * A hub that accepts the attachment and every batch, and keeps the batches.
 *
 * In memory, but on the real codec: payloads are encoded by the same
 * `RpcSerialization.ndjson` holes a socket would use, so a record the wire
 * rejects is rejected here too.
 */
function fakeHub(): {
  readonly batches: Array<Batch>;
  readonly layer: Layer.Layer<RpcClient.Protocol>;
} {
  const batches: Array<Batch> = [];
  let deliver: ((data: RpcMessage.FromServerEncoded) => Effect.Effect<void>) | undefined;

  const protocol: RpcClient.Protocol["Service"] = {
    codecFor: RpcSerialization.ndjson.codecFor,
    supportsAck: false,
    supportsTransferables: false,
    run: (_clientId, write) => {
      deliver = write;
      return Effect.never;
    },
    send: (_clientId, request) => {
      if (request._tag !== "Request" || deliver === undefined) {
        return Effect.void;
      }

      if (request.tag === "Frond.Attach") {
        return deliver({
          _tag: "Chunk",
          requestId: request.id,
          values: [{ _tag: "Attached", attachmentId: "attachment-1", values: "shape" }],
        });
      }

      if (request.tag === "Frond.Ingest") {
        batches.push(request.payload as Batch);
      }

      return deliver({
        _tag: "Exit",
        requestId: request.id,
        exit: { _tag: "Success", value: null },
      });
    },
  };

  return { batches, layer: Layer.succeed(RpcClient.Protocol)(protocol) };
}

/** A runtime that emits exactly the records the test hands it. */
function fakeRuntime(): {
  readonly runtime: Runtime.Runtime;
  readonly emit: (record: Runtime.RuntimeEventRecord) => void;
} {
  let listener: ((record: Runtime.RuntimeEventRecord) => void) | undefined;
  const runtime = {
    observe: (next: (record: Runtime.RuntimeEventRecord) => void) => {
      listener = next;
      return { unsubscribe: () => undefined };
    },
    getSnapshotSync: () => ({ runtimeId: "runtime-1" }),
  } as unknown as Runtime.Runtime;

  return { runtime, emit: (record) => listener?.(record) };
}

/**
 * A record the wire accepts, or, with `category: "graph"`, one it rejects: the
 * category is a closed set of literals on the wire and `"graph"` is not one.
 */
function recordOf(sequence: number, category = "state"): Runtime.RuntimeEventRecord {
  return {
    runtimeId: "runtime-1",
    sequence,
    recordedAt: 1000,
    work: {
      workId: 1,
      parentWorkId: undefined,
      source: "manual",
      reason: "refresh",
      priority: "background",
    },
    event: { _tag: "Probe" },
    classification: { category, severity: "info", timeline: "state", reportable: true },
    nodeIds: [],
    failures: [],
  } as unknown as Runtime.RuntimeEventRecord;
}

/** Longer than one flush interval, so each call lands in its own batch. */
const pastOneFlush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

describe("attachRuntime", () => {
  test("a record that fails to encode is lost, and the records after it are not", async () => {
    const hub = fakeHub();
    const { runtime, emit } = fakeRuntime();
    const fiber = Effect.runFork(
      attachRuntime({ runtime, attachUrl: "ws://unused", name: "app", platform: "test" }).pipe(
        Effect.scoped,
        Effect.provide(hub.layer)
      )
    );

    try {
      await pastOneFlush();
      emit(recordOf(1));
      await pastOneFlush();
      emit(recordOf(2, "graph"));
      await pastOneFlush();
      emit(recordOf(3));
      await pastOneFlush();

      const sent = hub.batches.flatMap((batch) => batch.records.map((record) => record.sequence));

      expect(sent).toEqual([1, 3]);
      // Counted where a record the buffer could not hold is counted, so the hub
      // shows the gap instead of a stream that reads as complete.
      expect(hub.batches.reduce((sum, batch) => sum + batch.droppedSince, 0)).toBe(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });
});
