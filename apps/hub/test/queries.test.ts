import { describe, expect, test } from "bun:test";
import type { GraphSnapshot, HubCommand, QueryOutcome } from "@frondruntime/devtools";
import type { Duration } from "effect";
import { Effect, Fiber, Queue } from "effect";
import { QueryBroker } from "../src/queries.ts";

const ATTACHMENT = "att-1";

function snapshot(): GraphSnapshot {
  return {
    capturedAt: 1_000,
    runtimeId: "runtime-1",
    runtimeStatus: "running",
    graphStatus: "running",
    observedInputs: 0,
    values: "shape",
    nodes: [],
    edges: [],
  };
}

const answered: QueryOutcome = { _tag: "Snapshot", snapshot: snapshot() };

/**
 * Reads the one command the broker should have queued.
 *
 * Narrowed here rather than at each call site because every test that gets this
 * far needs the `requestId` off it, and a `HubCommand` that turned out to be a
 * `Ping` is a failure worth naming once.
 */
const takeQuery = (outbound: Queue.Queue<HubCommand>) =>
  Effect.map(Queue.take(outbound), (command) => {
    if (command._tag !== "Query") {
      throw new Error(`expected a Query command, got ${command._tag}`);
    }

    return command;
  });

const channel = Effect.fnUntraced(function* (timeout?: Duration.Input) {
  const outbound = yield* Queue.unbounded<HubCommand>();
  const broker = new QueryBroker(timeout);

  broker.open(ATTACHMENT, outbound);

  return { broker, outbound };
});

describe("QueryBroker", () => {
  test("a reply settles the request that asked for it", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { broker, outbound } = yield* channel();

        const asking = yield* Effect.forkChild(broker.ask(ATTACHMENT, { _tag: "Graph" }, "full"));

        const command = yield* takeQuery(outbound);

        expect(command.query).toEqual({ _tag: "Graph" });
        expect(command.values).toBe("full");

        broker.settle(ATTACHMENT, command.requestId, answered);

        return yield* Fiber.join(asking);
      })
    );

    expect(outcome).toEqual(answered);
  });

  test("a node query carries the node it is about", async () => {
    const query = await Effect.runPromise(
      Effect.gen(function* () {
        const { broker, outbound } = yield* channel();

        yield* Effect.forkChild(
          broker.ask(ATTACHMENT, { _tag: "Node", nodeId: "orders:v1" }, "shape")
        );

        return (yield* takeQuery(outbound)).query;
      })
    );

    expect(query).toEqual({ _tag: "Node", nodeId: "orders:v1" });
  });

  /**
   * The reason `close` exists at all. Without it a socket that drops mid-query
   * reports a five-second silence for something the hub knew about the moment
   * the stream ended.
   */
  test("detaching fails everything still waiting, without waiting for the timeout", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const { broker, outbound } = yield* channel("60 seconds");

        const asking = yield* Effect.forkChild(broker.ask(ATTACHMENT, { _tag: "Graph" }, "full"));

        yield* takeQuery(outbound);

        broker.close(ATTACHMENT);

        return yield* Fiber.await(asking);
      })
    );

    expect(exit._tag).toBe("Failure");
  });

  test("an attachment that never answers times out", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const { broker } = yield* channel("10 millis");

        return yield* Effect.exit(broker.ask(ATTACHMENT, { _tag: "Graph" }, "full"));
      })
    );

    expect(exit._tag).toBe("Failure");
  });

  test("querying an attachment that is not connected fails rather than hangs", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(new QueryBroker().ask("nobody", { _tag: "Graph" }, "full"))
    );

    expect(exit._tag).toBe("Failure");
  });

  /**
   * A reply that arrives after its request timed out is the app being slow, not
   * the app being wrong — it has to be dropped rather than thrown, because the
   * `Frond.Reply` handler has nowhere useful to put a failure.
   */
  test("a reply nobody is waiting for is dropped", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { broker } = yield* channel();

        broker.settle(ATTACHMENT, "no-such-request", answered);
        broker.settle("no-such-attachment", "no-such-request", answered);
      })
    );
  });

  /**
   * `requestId`s are minted per broker, so one attachment's id can collide with
   * nothing — but a reply naming the wrong attachment must still not settle a
   * request made on another one.
   */
  test("a reply can only settle a request made on the same attachment", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const { broker, outbound } = yield* channel("50 millis");
        const other = yield* Queue.unbounded<HubCommand>();

        broker.open("att-2", other);

        const asking = yield* Effect.forkChild(broker.ask(ATTACHMENT, { _tag: "Graph" }, "full"));
        const command = yield* takeQuery(outbound);

        broker.settle("att-2", command.requestId, answered);

        return yield* Fiber.await(asking);
      })
    );

    expect(exit._tag).toBe("Failure");
  });

  /**
   * The bound that keeps the outbound queue finite. Nothing drains it here, so
   * this is exactly the half-open socket the cap exists for.
   */
  test("an attachment that stops answering stops accepting queries", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function* () {
        const { broker } = yield* channel("60 seconds");

        for (let index = 0; index < 32; index += 1) {
          yield* Effect.forkChild(broker.ask(ATTACHMENT, { _tag: "Graph" }, "full"));
        }

        // The forks above are only scheduled; yielding once lets each of them
        // register its pending entry before the cap is tested.
        yield* Effect.yieldNow;

        const exit = yield* Effect.exit(broker.ask(ATTACHMENT, { _tag: "Graph" }, "full"));

        return exit._tag;
      })
    );

    expect(failures).toBe("Failure");
  });
});
