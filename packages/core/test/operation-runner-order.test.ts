// Pins the observable order of an action, a refresh, and an args update: the
// start event, the change notices, the action completion, the caller's
// resume, and what a cancel during a post-settle sink leaves behind.
import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import type { GraphOperationStarted } from "../src/graph";
import {
  type ActionContract,
  Driver,
  dependencies,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly value: number };
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: { readonly bump: ActionContract<number, number> };
}>;

class Counter extends NodeBase<Spec> {
  static readonly spec = serviceSpec.async<Spec>({
    tag: "operation-runner-order/counter",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire((ctx) => ctx.args.value),
    refresh: Driver.Refresh((ctx) => {
      ctx.setResult(ctx.args.value + 10);
    }),
    actions: {
      bump: Driver.Action((_ctx, input) => input + 1),
    },
  });
}

type Kind = "action" | "refresh" | "args";
type Channel = "changed" | "completed";

const kinds = ["action", "refresh", "args"] as const;

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A graph with one ready Counter whose observers log every start, change, and
 * action completion, and park the `index`-th notice on `channel` when asked.
 */
async function setup(park?: { readonly channel: Channel; readonly index: number }) {
  const graph = makeInMemoryGraphSystem();
  const request = { spec: Counter, args: { value: 1 } };
  await Effect.runPromise(graph.ensureReadyNode(request));
  const nodeId = graph.resolveNodeIdSync(request);
  const log: string[] = [];
  const started: GraphOperationStarted[] = [];
  const parked = Promise.withResolvers<void>();
  const gate = { release: () => {} };
  const counts = { changed: 0, completed: 0 };
  const maybePark = (channel: Channel) => {
    counts[channel] += 1;
    if (park === undefined || park.channel !== channel || park.index !== counts[channel])
      return Effect.void;
    return Effect.callback<void>((resume) => {
      gate.release = () => resume(Effect.void);
      parked.resolve();
    });
  };
  await Effect.runPromise(
    graph.observeOperationStarts((event) => {
      log.push(`started:${event._tag}`);
      started.push(event);
      return Effect.void;
    })
  );
  await Effect.runPromise(
    graph.observeNodeChanges((changed) => {
      if (changed !== nodeId) return Effect.void;
      log.push("changed");
      return maybePark("changed");
    })
  );
  await Effect.runPromise(
    graph.observeActionCompletions((completion) => {
      log.push(`completed:${completion.result._tag}`);
      return maybePark("completed");
    })
  );
  const run = (kind: Kind): Effect.Effect<{ readonly _tag: string }> => {
    const operation = (() => {
      switch (kind) {
        case "action":
          return graph.runAction({ target: { _tag: "NodeId", nodeId }, action: "bump", input: 1 });
        case "refresh":
          return graph.refreshNode({ target: { _tag: "NodeId", nodeId } });
        case "args":
          return graph.updateNodeArgs({ nodeId, spec: Counter, args: { value: 2 } });
      }
    })();
    return operation.pipe(Effect.tap(() => Effect.sync(() => log.push("resumed"))));
  };
  const operationState = async () => {
    const lookup = await Effect.runPromise(graph.readNodeSnapshot(nodeId));
    if (lookup._tag !== "Found") return lookup._tag;
    const { operation, operationFailure } = lookup.snapshot as unknown as {
      readonly operation: unknown;
      readonly operationFailure?: unknown;
    };
    return { operation, operationFailure };
  };
  return { graph, nodeId, log, started, parked: parked.promise, gate, run, operationState };
}

const startedEvent = (kind: Kind, nodeId: string): GraphOperationStarted => {
  const operation = {
    _tag: "Running",
    operationId: expect.any(Number),
    startedAt: expect.any(Number),
  } as const;
  switch (kind) {
    case "action":
      return {
        _tag: "ActionStarted",
        nodeId,
        operation: { ...operation, kind: "action", action: "bump" },
        action: "bump",
        input: 1,
      };
    case "refresh":
      return {
        _tag: "RefreshStarted",
        nodeId,
        operation: { ...operation, kind: "refresh", action: undefined },
      };
    case "args":
      return {
        _tag: "ArgsUpdateStarted",
        nodeId,
        operation: { ...operation, kind: "args", action: undefined },
      };
  }
};

const startedTag = {
  action: "started:ActionStarted",
  refresh: "started:RefreshStarted",
  args: "started:ArgsUpdateStarted",
} as const;

for (const kind of kinds) {
  test(`${kind} runs start, change, driver, change, then resumes`, async () => {
    const harness = await setup();
    harness.log.length = 0;
    const result = await Effect.runPromise(harness.run(kind));
    await macrotask();

    expect(result._tag).toBe("Success");
    expect(harness.log).toEqual(
      kind === "action"
        ? [startedTag[kind], "changed", "changed", "completed:Success", "resumed"]
        : [startedTag[kind], "changed", "changed", "resumed"]
    );
    expect(harness.started).toStrictEqual([startedEvent(kind, harness.nodeId)]);
    expect(await harness.operationState()).toEqual({
      operation: { _tag: "Idle" },
      operationFailure: undefined,
    });
  });

  test(`${kind} evicted during its post-settle change sink resumes once with the eviction`, async () => {
    const harness = await setup({ channel: "changed", index: 2 });
    harness.log.length = 0;
    const caller = Effect.runPromise(Effect.exit(harness.run(kind)));
    await harness.parked;
    harness.log.push("evict");
    const evicted = Effect.runPromise(
      harness.graph.evictSubgraph({ rootNodeIds: [harness.nodeId], mode: "selfAndDependents" })
    );
    await macrotask();
    harness.log.push("release");
    harness.gate.release();
    await evicted;
    const exit = await caller;
    await macrotask();
    await macrotask();

    // The parked sink is not the operation's to interrupt; once released, the
    // settled operation starts no further sink.
    expect(harness.log).toEqual(
      kind === "action"
        ? [
            startedTag[kind],
            "changed",
            "changed",
            "evict",
            "completed:Failure",
            "changed",
            "resumed",
            "release",
          ]
        : [startedTag[kind], "changed", "changed", "evict", "changed", "resumed", "release"]
    );
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      _tag: "Failure",
      error: { cause: { _tag: "NodeEvicted", cancellation: { _tag: "Evicted" } } },
    });
    expect(await harness.operationState()).toBe("Missing");
  });
}

test("an action evicted during its completion sink resumes once with the eviction", async () => {
  const harness = await setup({ channel: "completed", index: 1 });
  harness.log.length = 0;
  const caller = Effect.runPromise(Effect.exit(harness.run("action")));
  await harness.parked;
  harness.log.push("evict");
  const evicted = Effect.runPromise(
    harness.graph.evictSubgraph({ rootNodeIds: [harness.nodeId], mode: "selfAndDependents" })
  );
  await macrotask();
  harness.log.push("release");
  harness.gate.release();
  await evicted;
  const exit = await caller;
  await macrotask();
  await macrotask();

  expect(harness.log).toEqual([
    "started:ActionStarted",
    "changed",
    "changed",
    "completed:Success",
    "evict",
    "completed:Failure",
    "changed",
    "resumed",
    "release",
  ]);
  expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
    _tag: "Failure",
    error: { _tag: "ActionFailed", cause: { _tag: "NodeEvicted" } },
  });
});

for (const channel of ["changed", "completed"] as const) {
  test(`an action caller interrupted during its post-settle ${channel === "changed" ? "change" : "completion"} sink ends idle`, async () => {
    const harness = await setup(
      channel === "changed" ? { channel, index: 2 } : { channel, index: 1 }
    );
    harness.log.length = 0;
    const fiber = Effect.runFork(harness.run("action"));
    await harness.parked;
    harness.log.push("interrupt");
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await macrotask();
    harness.log.push("release");
    harness.gate.release();
    await interrupted;
    await macrotask();
    await macrotask();

    expect(harness.log).toEqual(
      channel === "changed"
        ? [
            "started:ActionStarted",
            "changed",
            "changed",
            "interrupt",
            "completed:Failure",
            "changed",
            "release",
          ]
        : [
            "started:ActionStarted",
            "changed",
            "changed",
            "completed:Success",
            "interrupt",
            "completed:Failure",
            "changed",
            "release",
          ]
    );
    expect(await harness.operationState()).toEqual({
      operation: { _tag: "Idle" },
      operationFailure: undefined,
    });
  });
}

for (const kind of ["refresh", "args"] as const) {
  test(`a ${kind} caller interrupted during its post-settle change sink leaves the ${kind} running to its end`, async () => {
    const harness = await setup({ channel: "changed", index: 2 });
    harness.log.length = 0;
    const fiber = Effect.runFork(harness.run(kind));
    await harness.parked;
    harness.log.push("interrupt");
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await macrotask();
    harness.log.push("release");
    harness.gate.release();
    await interrupted;
    await macrotask();
    await macrotask();

    expect(harness.log).toEqual([startedTag[kind], "changed", "changed", "interrupt", "release"]);
    expect(await harness.operationState()).toEqual({
      operation: { _tag: "Idle" },
      operationFailure: undefined,
    });
  });
}
