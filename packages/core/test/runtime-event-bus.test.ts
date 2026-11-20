import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { NodeId } from "../src/graph";
import { makeRuntimeEventBus } from "../src/runtime/eventBus";
import type { RuntimeEventRecord, RuntimeId } from "../src/runtime/types";
import { makeRuntimeWorkFactory } from "../src/runtime/work";

const runtimeId = "event-bus-test" as RuntimeId;
const nodeA = "node-a" as NodeId;
const nodeB = "node-b" as NodeId;
const work = makeRuntimeWorkFactory(runtimeId).defaultWork;

function makeBus(eventBufferSize = 16) {
  return makeRuntimeEventBus({
    runtimeId,
    eventBufferSize,
    sinks: [],
    syncClock: { now: () => 42 },
    fallbackWork: () => work,
  });
}

describe("synchronous event bus", () => {
  test("dispatches inline with the runtime clock and no Effect execution", () => {
    const bus = makeBus();
    const received: RuntimeEventRecord[] = [];
    Effect.runSync(bus.observe((record) => received.push(record)));

    expect(bus.emit({ _tag: "RuntimeStarted", at: 1 })).toBe(Effect.void);
    expect(received).toHaveLength(1);
    expect(received[0]?.recordedAt).toBe(42);
    expect(bus.events()).toEqual(received);
  });

  test("skips the clock, metadata and record when nobody listens and retention is zero", () => {
    const bus = makeRuntimeEventBus({
      runtimeId,
      eventBufferSize: 0,
      sinks: [],
      syncClock: {
        now: () => {
          throw new Error("unused clock");
        },
      },
      fallbackWork: () => {
        throw new Error("unused metadata");
      },
    });
    const unusedEvent = {
      get _tag(): "RuntimeStarted" {
        throw new Error("unused classification");
      },
      at: 1,
    };

    expect(bus.emit(unusedEvent)).toBe(Effect.void);
    expect(bus.events()).toEqual([]);
  });

  test("keeps sequence numbers across skipped records and never retains zero-buffer delivery", () => {
    const bus = makeBus(0);
    bus.emit({ _tag: "RuntimeStarted", at: 1 });
    const received: RuntimeEventRecord[] = [];
    Effect.runSync(bus.observe((record) => received.push(record)));
    bus.emit({ _tag: "GraphSystemStarted", at: 2 });

    expect(received[0]?.sequence).toBe(2);
    expect(bus.events()).toEqual([]);
  });

  test("keeps the current snapshot when listeners unsubscribe and subscribe during delivery", () => {
    const bus = makeBus();
    const calls: string[] = [];
    const late = () => {
      calls.push("late");
    };
    let removeSecond = () => {};
    Effect.runSync(
      bus.observe(() => {
        calls.push("first");
        removeSecond();
        Effect.runSync(bus.observe(late));
      })
    );
    removeSecond = Effect.runSync(
      bus.observe(() => {
        calls.push("second");
      })
    ).unsubscribe;

    bus.emit({ _tag: "RuntimeStarted", at: 1 });
    expect(calls).toEqual(["first", "second"]);
    calls.length = 0;
    bus.emit({ _tag: "GraphSystemStarted", at: 2 });
    expect(calls).toEqual(["first", "late"]);
  });

  test("indexes single-node listeners and preserves global order and multi-node deduplication", () => {
    const bus = makeBus();
    const calls: string[] = [];
    Effect.runSync(
      bus.observe(() => {
        calls.push("a");
      }, nodeA)
    );
    Effect.runSync(
      bus.observe(() => {
        calls.push("global");
      })
    );
    Effect.runSync(
      bus.observe(() => {
        calls.push("b");
      }, nodeB)
    );
    Effect.runSync(
      bus.observe(() => {
        calls.push("last-a");
      }, nodeA)
    );

    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 1 });
    expect(calls).toEqual(["a", "global", "last-a"]);
    calls.length = 0;
    bus.emit({ _tag: "GraphNodesEvicted", nodeIds: [nodeB, nodeA, nodeA], failures: [], at: 2 });
    expect(calls).toEqual(["a", "global", "b", "last-a"]);
    calls.length = 0;
    bus.emit({ _tag: "RuntimeStarted", at: 3 });
    expect(calls).toEqual(["global"]);
  });

  test("keeps the current node snapshot when node and global listeners change during delivery", () => {
    const bus = makeBus();
    const calls: string[] = [];
    let removeLater = () => {};
    const lateNode = () => {
      calls.push("late-a");
    };
    const lateGlobal = () => {
      calls.push("late-global");
    };
    bus.observeSync(() => {
      calls.push("first-a");
      removeLater();
      bus.observeSync(lateNode, nodeA);
      bus.observeSync(lateGlobal);
    }, nodeA);
    removeLater = bus.observeSync(() => {
      calls.push("later-a");
    }, nodeA).unsubscribe;

    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 1 });
    expect(calls).toEqual(["first-a", "later-a"]);
    calls.length = 0;
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 2 });
    expect(calls).toEqual(["first-a", "late-a", "late-global"]);
  });

  test("drops a node's cached delivery list when a global listener comes and goes", () => {
    const bus = makeBus();
    const calls: string[] = [];
    bus.observeSync(() => {
      calls.push("a");
    }, nodeA);
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 1 });
    const global = bus.observeSync(() => {
      calls.push("global");
    });
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 2 });
    global.unsubscribe();
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 3 });
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeB, at: 4 });

    expect(calls).toEqual(["a", "a", "global", "a"]);
  });

  test("keeps registration order across unsubscribes and later subscriptions", () => {
    const bus = makeBus();
    const calls: string[] = [];
    const observe = (name: string, nodeId?: NodeId) =>
      bus.observeSync(() => {
        calls.push(name);
      }, nodeId);
    observe("a1", nodeA);
    observe("g1");
    const b1 = observe("b1", nodeB);
    const a2 = observe("a2", nodeA);
    observe("g2");
    b1.unsubscribe();
    a2.unsubscribe();
    observe("b2", nodeB);
    observe("a3", nodeA);
    observe("g3");

    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 1 });
    expect(calls).toEqual(["a1", "g1", "g2", "a3", "g3"]);
    calls.length = 0;
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeB, at: 2 });
    expect(calls).toEqual(["g1", "g2", "b2", "g3"]);
    calls.length = 0;
    bus.emit({ _tag: "GraphNodesEvicted", nodeIds: [nodeB, nodeA], failures: [], at: 3 });
    expect(calls).toEqual(["a1", "g1", "g2", "b2", "a3", "g3"]);
    calls.length = 0;
    bus.emit({ _tag: "RuntimeStarted", at: 4 });
    expect(calls).toEqual(["g1", "g2", "g3"]);
  });

  test("moves a re-registered listener to its new node at its first position", () => {
    const bus = makeBus();
    const calls: string[] = [];
    const moved = () => {
      calls.push("moved");
    };
    const first = bus.observeSync(moved, nodeA);
    bus.observeSync(() => {
      calls.push("b");
    }, nodeB);
    bus.observeSync(() => {
      calls.push("global");
    });
    bus.observeSync(moved, nodeB);

    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 1 });
    expect(calls).toEqual(["global"]);
    calls.length = 0;
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeB, at: 2 });
    expect(calls).toEqual(["moved", "b", "global"]);
    calls.length = 0;
    bus.observeSync(moved);
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 3 });
    expect(calls).toEqual(["moved", "global"]);
    calls.length = 0;
    // Either handle removes the one registration of the function.
    first.unsubscribe();
    bus.emit({ _tag: "RuntimeStarted", at: 4 });
    expect(calls).toEqual(["global"]);
  });

  test("tolerates a second unsubscribe and falls back to globals for an emptied node", () => {
    const bus = makeBus();
    const calls: string[] = [];
    const nodeListener = bus.observeSync(() => {
      calls.push("a");
    }, nodeA);
    const other = bus.observeSync(() => {
      calls.push("other-a");
    }, nodeA);
    bus.observeSync(() => {
      calls.push("global");
    });
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 1 });
    nodeListener.unsubscribe();
    nodeListener.unsubscribe();
    other.unsubscribe();
    bus.emit({ _tag: "GraphNodeChanged", nodeId: nodeA, at: 2 });
    bus.emit({ _tag: "GraphNodesEvicted", nodeIds: [nodeA, nodeB], failures: [], at: 3 });

    expect(calls).toEqual(["a", "other-a", "global", "global", "global"]);
  });

  test("skips record creation again once every listener has unsubscribed", () => {
    let clockReads = 0;
    const bus = makeRuntimeEventBus({
      runtimeId,
      eventBufferSize: 0,
      sinks: [],
      syncClock: {
        now: () => {
          clockReads += 1;
          return 0;
        },
      },
      fallbackWork: () => work,
    });
    const global = bus.observeSync(() => undefined);
    const node = bus.observeSync(() => undefined, nodeA);
    bus.emit({ _tag: "RuntimeStarted", at: 1 });
    expect(clockReads).toBe(1);
    global.unsubscribe();
    bus.emit({ _tag: "RuntimeStarted", at: 2 });
    expect(clockReads).toBe(2);
    node.unsubscribe();
    bus.emit({ _tag: "RuntimeStarted", at: 3 });
    expect(clockReads).toBe(2);
  });

  test("awaits observer-failure sinks before later observers and original-event sinks", async () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    const bus = makeRuntimeEventBus({
      runtimeId,
      eventBufferSize: 16,
      syncClock: { now: () => 42 },
      fallbackWork: () => work,
      sinks: [
        {
          name: "slow",
          handle: (record) =>
            Effect.gen(function* () {
              calls.push(record.event._tag);
              if (record.event._tag === "RuntimeObserverFailureObserved") {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
            }),
        },
      ],
    });
    Effect.runSync(
      bus.observe(() => {
        throw new Error("listener");
      })
    );
    const second = Effect.runSync(
      bus.observe(() => {
        calls.push("second");
      })
    );
    const pending = Effect.runPromise(bus.emit({ _tag: "RuntimeStarted", at: 1 }));
    await Effect.runPromise(Deferred.await(started));
    expect(calls).toEqual(["RuntimeObserverFailureObserved"]);
    second.unsubscribe();
    Effect.runSync(
      bus.observe(() => {
        calls.push("late");
      })
    );
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await pending;

    expect(calls).toEqual(["RuntimeObserverFailureObserved", "second", "RuntimeStarted"]);
    expect(bus.events().map((record) => record.recordedAt)).toEqual([42, 42]);
  });

  test("keeps sinks concurrent and waits for every sink without failing the caller", async () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    const bus = makeRuntimeEventBus({
      runtimeId,
      eventBufferSize: 16,
      syncClock: { now: () => 42 },
      fallbackWork: () => work,
      sinks: [
        {
          name: "blocked",
          handle: () =>
            Effect.gen(function* () {
              calls.push("blocked");
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              calls.push("released");
            }),
        },
        {
          name: "failure",
          handle: () =>
            Effect.sync(() => {
              calls.push("failure");
            }).pipe(Effect.andThen(Effect.fail("sink failed"))),
        },
      ],
    });
    let settled = false;
    const pending = Effect.runPromise(bus.emit({ _tag: "RuntimeStarted", at: 1 })).then(() => {
      settled = true;
    });
    await Effect.runPromise(Deferred.await(started));
    expect(calls).toEqual(["blocked", "failure"]);
    expect(settled).toBe(false);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await pending;

    expect(calls).toEqual(["blocked", "failure", "released"]);
    expect(bus.events().map((record) => record.event._tag)).toEqual([
      "RuntimeStarted",
      "RuntimeSinkFailureObserved",
    ]);
    expect(bus.events()[1]?.recordedAt).toBe(42);
  });
});
