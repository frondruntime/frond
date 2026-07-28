import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Args, createRuntime, type Runtime } from "@frondruntime/core";
import type { GraphSnapshot, StateQuery, ValuePolicy } from "@frondruntime/devtools";
import {
  attachLayer,
  attachRuntime,
  FrondHubRpcs,
  HUB_PROTOCOL_VERSION,
} from "@frondruntime/devtools";
import { Effect, Fiber, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { isHubInternal } from "../src/hubInternal.ts";
import type { AttachmentView } from "../src/nodes/attachments.ts";
import { AttachmentsNode } from "../src/nodes/attachments.ts";
import { HubServerNode } from "../src/nodes/hubServer.ts";
import type { QueryBroker } from "../src/queries.ts";
import type { EventRing } from "../src/retention.ts";

const HOST = "127.0.0.1";

/**
 * Ports are picked per test rather than fixed: these tests bind a real
 * listening socket, and a fixed port turns an unrelated process into a flake.
 */
let nextPort = 7500 + Math.floor(Math.random() * 400);

function takePort(): number {
  nextPort += 1;
  return nextPort;
}

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) {
    await teardown.pop()?.();
  }
});

async function startHub(port: number): Promise<{
  readonly runtime: Runtime.Runtime;
  readonly attachUrl: string;
  readonly lockfilePath: string;
  readonly stop: () => Promise<void>;
  readonly attachments: () => ReadonlyArray<AttachmentView>;
  readonly retained: (attachmentId: string) => EventRing | undefined;
  readonly queries: () => QueryBroker;
}> {
  const runtime = createRuntime();
  await runtime.submit({ _tag: "RuntimeStart" });

  const handle = runtime.client.node(HubServerNode, {
    host: HOST,
    port,
    // Nothing here self-attaches, so this only has to be an id no dialled
    // attachment will collide with — which is the whole point of it being
    // minted rather than read off the runtime.
    selfInstanceId: crypto.randomUUID(),
  });
  const server = await handle.ensureReadyNode();

  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    await handle.releaseResources("test teardown");
    await runtime.submit({ _tag: "RuntimeStop", reason: "test teardown" });
  };

  teardown.push(stop);

  const attachmentsHandle = runtime.client.node(AttachmentsNode, Args.none);

  return {
    runtime,
    attachUrl: server.result.attachUrl,
    lockfilePath: server.result.lockfilePath,
    stop,
    attachments: () => [...attachmentsHandle.readReady().result.attachments.values()],
    retained: (attachmentId: string) =>
      attachmentsHandle.readReady().result.retained.get(attachmentId),
    queries: () => attachmentsHandle.readReady().result.queries,
  };
}

function dial(options: {
  readonly runtime: Runtime.Runtime;
  readonly attachUrl: string;
  readonly name: string;
  readonly include?: (record: Runtime.RuntimeEventRecord) => boolean;
  /** The app's ceiling. Defaults to `"shape"` inside `attachRuntime`. */
  readonly values?: ValuePolicy;
}): Fiber.Fiber<void, unknown> {
  const fiber = Effect.runFork(
    attachRuntime({ ...options, platform: "bun" }).pipe(
      Effect.scoped,
      Effect.provide(attachLayer(options.attachUrl))
    )
  );

  teardown.push(async () => {
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  return fiber;
}

/**
 * Polls rather than awaits a signal on purpose: an attachment becomes visible
 * through a socket round trip and an action the cell actor serializes, and
 * there is deliberately no API that lets a caller wait on someone else's
 * attachment.
 */
async function waitFor<A>(
  read: () => A,
  predicate: (value: A) => boolean,
  label: string
): Promise<A> {
  const deadline = Date.now() + 5000;

  for (;;) {
    const value = read();

    if (predicate(value)) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await Bun.sleep(20);
  }
}

/**
 * Asks, and insists on a snapshot.
 *
 * The `Failed` arm is unwrapped here rather than asserted on in each test: it
 * means the app could not build the snapshot, which in these tests is never the
 * thing under test and always worth seeing the reason for.
 */
async function read(
  hub: { readonly queries: () => QueryBroker },
  attachmentId: string,
  query: StateQuery,
  values: ValuePolicy
): Promise<GraphSnapshot> {
  const outcome = await Effect.runPromise(hub.queries().ask(attachmentId, query, values));

  if (outcome._tag === "Failed") {
    throw new Error(`the app refused the query: ${outcome.reason}`);
  }

  return outcome.snapshot;
}

describe("hub attachment", () => {
  test("a runtime that dials the hub shows up as an attachment", async () => {
    const hub = await startHub(takePort());

    dial({ ...hub, name: "probe" });

    const attachments = await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.info.name).toBe("probe");
    expect(attachments[0]?.info.platform).toBe("bun");
    expect(attachments[0]?.droppedCount).toBe(0);
  });

  test("events reach the hub after the attachment is established", async () => {
    const hub = await startHub(takePort());

    dial({ ...hub, name: "probe" });

    await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");

    // Any graph work produces runtime events; starting a second handle is the
    // cheapest way to make some.
    await hub.runtime.client.node(AttachmentsNode, Args.none).ensureReady();

    const attachments = await waitFor(
      hub.attachments,
      (rows) => (rows[0]?.eventCount ?? 0) > 0,
      "ingested events"
    );

    const row = attachments[0];

    expect(row?.eventCount).toBeGreaterThan(0);
    expect(row?.lastSequence).toBeGreaterThan(0);
    expect(typeof row?.lastTag).toBe("string");
  });

  /**
   * The counter on the row and the records in the ring come from the same
   * action, and a reader that trusts one while the other is empty gets a hub
   * that claims history it cannot produce.
   */
  test("ingested events are retained for reading, not just counted", async () => {
    const hub = await startHub(takePort());

    dial({ ...hub, name: "probe" });

    const [attachment] = await waitFor(
      hub.attachments,
      (rows) => (rows[0]?.eventCount ?? 0) > 0,
      "ingested events"
    );

    const ring = hub.retained(attachment?.attachmentId ?? "");
    const window = ring?.read({ limit: 5 });

    expect(ring?.size).toBe(attachment?.eventCount ?? -1);
    expect(window?.records.length).toBeGreaterThan(0);
    expect(window?.oldestRetainedSequence).toBe(window?.records[0]?.sequence);
    // Sequences arrive ascending, which is what `since` paging assumes.
    expect(window?.records.map((row) => row.sequence)).toEqual(
      [...(window?.records ?? [])].map((row) => row.sequence).sort((left, right) => left - right)
    );
  });

  test("the retained history goes away with the attachment", async () => {
    const hub = await startHub(takePort());

    const fiber = dial({ ...hub, name: "probe" });

    const [attachment] = await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");
    const attachmentId = attachment?.attachmentId ?? "";

    expect(hub.retained(attachmentId)).toBeDefined();

    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitFor(hub.attachments, (rows) => rows.length === 0, "the detachment");

    expect(hub.retained(attachmentId)).toBeUndefined();
  });

  /**
   * The only rejection the hub has left, now that attaching is unauthenticated.
   * Dialled with a raw client rather than through `attachRuntime`, because
   * `attachRuntime` always sends the version it was compiled against — which is
   * the correct behaviour and the reason it cannot exercise this path.
   */
  test("a mismatched protocol version is rejected and never becomes an attachment", async () => {
    const hub = await startHub(takePort());

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(FrondHubRpcs);

          return yield* Stream.runCollect(
            client["Frond.Attach"]({
              info: {
                protocolVersion: HUB_PROTOCOL_VERSION + 1,
                instanceId: crypto.randomUUID(),
                runtimeId: "runtime-1",
                generation: 0,
                name: "from-the-future",
                platform: "bun",
                startedAt: 0,
                values: "shape",
              },
            })
          );
        }).pipe(Effect.scoped, Effect.provide(attachLayer(hub.attachUrl)))
      )
    );

    expect(exit._tag).toBe("Failure");
    expect(hub.attachments()).toHaveLength(0);
  });

  /**
   * The hub is attached to the runtime it writes ingested batches into, so
   * applying a batch emits the events that make up the next one. Left open,
   * that loop runs at the flush interval forever and the hub's own row climbs
   * on a completely idle machine.
   *
   * Quiescence is the assertion, not a count: a loop broken is a count that
   * stops moving, and any threshold here would just be the loop's period in
   * disguise.
   */
  test("self-attach excludes the hub's own nodes, so an idle hub goes quiet", async () => {
    const hub = await startHub(takePort());

    dial({ ...hub, name: "frond-hub", include: (record) => !isHubInternal(record) });

    await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");

    // Long enough for several flush intervals; the unfiltered loop measured
    // ~4 cycles a second, so a live loop cannot hide inside this window.
    await Bun.sleep(1500);
    const settled = hub.attachments()[0]?.eventCount ?? 0;

    await Bun.sleep(1500);

    expect(hub.attachments()[0]?.eventCount).toBe(settled);
  });

  /**
   * A lockfile that outlives its hub points the next reader at a dead port. It
   * survived release for a while: shutting down with a live attachment
   * interrupts the websocket handler, that interrupt surfaced as the scope
   * close's own outcome, and the release gave up before it reached the unlink.
   */
  test("the lockfile is gone once the hub releases, even with an app attached", async () => {
    const hub = await startHub(takePort());

    expect(existsSync(hub.lockfilePath)).toBe(true);

    dial({ ...hub, name: "probe" });

    await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");

    await hub.stop();

    expect(existsSync(hub.lockfilePath)).toBe(false);
  });

  /**
   * The query channel end to end: a command down the `Attach` response stream,
   * a snapshot back as a separate `Frond.Reply`, matched on `requestId`. The
   * runtime being read is the hub's own, which is the case that would break
   * first if the two halves ever disagreed about direction.
   */
  test("a graph query round-trips over the socket", async () => {
    const hub = await startHub(takePort());

    dial({ ...hub, name: "probe" });

    const [attachment] = await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");
    const attachmentId = attachment?.attachmentId ?? "";

    const snapshot = await read(hub, attachmentId, { _tag: "Graph" }, "full");

    expect(snapshot.runtimeStatus).toBe("running");
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    // The hub reads its own graph, so its own nodes are the ones that must be
    // there — anything else means the reply came from somewhere unexpected.
    expect(snapshot.nodes.map((row) => row.tag)).toContain("hub/attachments");
    expect(snapshot.nodes.every((row) => row.result === undefined)).toBe(true);
  });

  test("a node query returns that node with its result", async () => {
    const hub = await startHub(takePort());

    dial({ ...hub, name: "probe", values: "full" });

    const [attachment] = await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");
    const attachmentId = attachment?.attachmentId ?? "";

    const graph = await read(hub, attachmentId, { _tag: "Graph" }, "full");
    const ready = graph.nodes.find((row) => row.state === "Ready");
    const nodeId = ready?.nodeId ?? "";

    expect(nodeId).not.toBe("");

    const snapshot = await read(hub, attachmentId, { _tag: "Node", nodeId }, "full");

    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]?.nodeId).toBe(nodeId);
    expect(snapshot.nodes[0]?.result).toBeDefined();
  });

  /**
   * The hub asks for `"full"` on every query; the app decides. A ceiling the
   * sender merely announces is one the sender can forget to apply, so this
   * asserts the clamp on the answer rather than on the request.
   */
  test("the app's ceiling clamps a query that asked for more", async () => {
    const hub = await startHub(takePort());

    dial({ ...hub, name: "probe", values: "shape" });

    const [attachment] = await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");
    const attachmentId = attachment?.attachmentId ?? "";

    const graph = await read(hub, attachmentId, { _tag: "Graph" }, "full");
    const nodeId = graph.nodes.find((row) => row.state === "Ready")?.nodeId ?? "";

    const snapshot = await read(hub, attachmentId, { _tag: "Node", nodeId }, "full");

    expect(snapshot.values).toBe("shape");
    expect(snapshot.nodes[0]?.result).toMatchObject({ _: "object" });
  });

  test("a query for a detached attachment fails instead of waiting for the timeout", async () => {
    const hub = await startHub(takePort());

    const fiber = dial({ ...hub, name: "probe" });

    const [attachment] = await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");
    const attachmentId = attachment?.attachmentId ?? "";

    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitFor(hub.attachments, (rows) => rows.length === 0, "the detachment");

    const exit = await Effect.runPromise(
      Effect.exit(hub.queries().ask(attachmentId, { _tag: "Graph" }, "full"))
    );

    expect(exit._tag).toBe("Failure");
  });

  test("a dropped connection detaches", async () => {
    const hub = await startHub(takePort());

    const fiber = dial({ ...hub, name: "probe" });

    await waitFor(hub.attachments, (rows) => rows.length > 0, "an attachment");

    await Effect.runPromise(Fiber.interrupt(fiber));

    await waitFor(hub.attachments, (rows) => rows.length === 0, "the detachment");

    expect(hub.attachments()).toHaveLength(0);
  });
});
