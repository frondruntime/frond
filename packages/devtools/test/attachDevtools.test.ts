import { describe, expect, test } from "bun:test";
import { createRuntime, type Runtime } from "@frondruntime/core";
import { attachDevtools } from "../src/attachDevtools.ts";
import { HUB_DEFAULT_ATTACH_URL } from "../src/protocol.ts";

/**
 * A port nothing is listening on, so every attempt fails at connect.
 *
 * That is the state these tests care about, and it is also the state an app
 * spends most of its life in: a developer who has not started a hub is the
 * common case, not the error case.
 */
const DEAD_URL = "ws://127.0.0.1:1/attach";

async function runtime() {
  const created = createRuntime();

  await created.submit({ _tag: "RuntimeStart" });

  return created;
}

type Message = {
  readonly _tag: string;
  readonly id?: string;
  readonly tag?: string;
  readonly payload?: unknown;
};

/**
 * A hub behind a stand-in for the global `WebSocket`, which is what
 * `attachDevtools` dials through.
 *
 * Everything above the socket is the real thing: the RPC socket protocol, its
 * NDJSON framing, its heartbeat. The one thing this changes is `send`, which
 * throws on the first event batch of the first connection, the way a socket
 * whose write side broke does while its read side keeps answering.
 *
 * It serves only its own URL. A dial to any other, such as a retry left over
 * from a test above still dialing `DEAD_URL`, gets a socket that closes
 * before it opens, the way a dead port answers.
 */
function socketHub(): {
  readonly url: string;
  readonly attaches: Array<number>;
  readonly sent: Array<number>;
  readonly install: () => () => void;
} {
  const url = "ws://hub.test/attach";
  const attaches: Array<number> = [];
  const sent: Array<number> = [];
  let connections = 0;
  let writeFailed = false;

  class HubSocket {
    readyState = 0;
    binaryType = "blob";
    readonly connection = ++connections;
    readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(dialed: string) {
      setTimeout(() => {
        if (dialed !== url) {
          this.close(1006);
          return;
        }

        this.readyState = 1;
        this.dispatch("open", {});
      }, 0);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    dispatch(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        listener(event);
      }
    }

    reply(message: unknown): void {
      setTimeout(() => this.dispatch("message", { data: `${JSON.stringify(message)}\n` }), 0);
    }

    close(code = 1000): void {
      if (this.readyState === 3) {
        return;
      }

      this.readyState = 3;
      setTimeout(() => this.dispatch("close", { code, reason: "" }), 0);
    }

    send(data: string): void {
      for (const line of data.split("\n")) {
        if (line === "") {
          continue;
        }

        const message = JSON.parse(line) as Message;

        if (message._tag === "Ping") {
          this.reply({ _tag: "Pong" });
        } else if (message._tag === "Request" && message.tag === "Frond.Attach") {
          const { info } = message.payload as { readonly info: { readonly generation: number } };
          attaches.push(info.generation);
          this.reply({
            _tag: "Chunk",
            requestId: message.id,
            values: [
              { _tag: "Attached", attachmentId: `attachment-${this.connection}`, values: "shape" },
            ],
          });
        } else if (message._tag === "Request" && message.tag === "Frond.Ingest") {
          if (!writeFailed) {
            writeFailed = true;
            throw new Error("write side closed");
          }

          const { records } = message.payload as {
            readonly records: ReadonlyArray<{ readonly sequence: number }>;
          };

          for (const record of records) {
            sent.push(record.sequence);
          }

          this.reply({
            _tag: "Exit",
            requestId: message.id,
            exit: { _tag: "Success", value: null },
          });
        }
      }
    }
  }

  return {
    url,
    attaches,
    sent,
    install: () => {
      const original = globalThis.WebSocket;
      globalThis.WebSocket = HubSocket as unknown as typeof WebSocket;

      return () => {
        globalThis.WebSocket = original;
      };
    },
  };
}

/** A runtime that emits exactly the records the test hands it. */
function scriptedRuntime(): {
  readonly runtime: Runtime.Runtime;
  readonly emit: (sequence: number) => void;
} {
  let listener: ((record: Runtime.RuntimeEventRecord) => void) | undefined;
  const runtime = {
    observe: (next: (record: Runtime.RuntimeEventRecord) => void) => {
      listener = next;
      return { unsubscribe: () => undefined };
    },
    getSnapshotSync: () => ({ runtimeId: "runtime-1" }),
  } as unknown as Runtime.Runtime;

  const emit = (sequence: number): void =>
    listener?.({
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
      classification: { category: "state", severity: "info", timeline: "state", reportable: true },
      nodeIds: [],
      failures: [],
    } as unknown as Runtime.RuntimeEventRecord);

  return { runtime, emit };
}

async function until(condition: () => boolean, within: number): Promise<void> {
  const deadline = Date.now() + within;

  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(25);
  }
}

describe("attachDevtools", () => {
  /**
   * The property the whole front door exists for. This sits in an app's entry
   * file behind nothing but a dev check, so a throw here is a devtools client
   * taking down the app it was supposed to be observing.
   */
  test("dialing a hub that is not there neither throws nor rejects", async () => {
    const detach = attachDevtools({ runtime: await runtime(), url: DEAD_URL, name: "app" });

    // Several retry cycles would not fit here; one is enough to prove the
    // failure is caught rather than propagated, and the loop is asserted below.
    await Bun.sleep(150);

    detach();
  });

  test("errors are reported rather than raised, and it keeps trying", async () => {
    const seen: Array<unknown> = [];

    const detach = attachDevtools({
      runtime: await runtime(),
      url: DEAD_URL,
      name: "app",
      onError: (cause) => {
        seen.push(cause);
      },
    });

    // Longer than one retry delay, so a client that gave up after the first
    // failure reports exactly one cause and fails this.
    await Bun.sleep(2500);
    detach();

    expect(seen.length).toBeGreaterThan(1);
  });

  test("detaching twice is not an error", async () => {
    const detach = attachDevtools({ runtime: await runtime(), url: DEAD_URL, name: "app" });

    detach();
    detach();
  });

  /**
   * A socket whose write side fails while its read side keeps answering pings
   * is the case that hides: nothing on the read side ends the attachment, so
   * unless the failed send does, the app sits attached and silent for good.
   */
  test("a failed send ends the attachment, and the reconnect sends again", async () => {
    const hub = socketHub();
    const restore = hub.install();
    const { runtime, emit } = scriptedRuntime();
    const detach = attachDevtools({
      runtime,
      url: hub.url,
      name: "app",
      onError: () => undefined,
    });

    try {
      await until(() => hub.attaches.length === 1, 1000);
      emit(1);
      // One retry delay and a flush interval past the failed send.
      await until(() => hub.attaches.length === 2, 3500);
      emit(2);
      await until(() => hub.sent.length > 0, 1000);

      // The generation is how the hub tells a reconnect from a first attach.
      expect(hub.attaches).toEqual([0, 1]);
      // The batch that failed is lost with the attachment, as on any disconnect.
      expect(hub.sent).toEqual([2]);
    } finally {
      detach();
      restore();
    }
  }, 10_000);

  /**
   * The zero-config path: an app that passes no URL gets the default port. It
   * is the whole reason dropping the attach token was worth doing, so it is
   * worth an assertion rather than a comment.
   */
  test("the default URL is the hub's default port on loopback", () => {
    expect(HUB_DEFAULT_ATTACH_URL).toBe("ws://127.0.0.1:17391/attach");
  });
});
