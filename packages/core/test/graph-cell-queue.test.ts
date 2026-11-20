import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit, Fiber } from "effect";
import type { RuntimeCancellationReason } from "../src/cancellation";
import type { NodeId } from "../src/graph";
import type { GraphNodeCell } from "../src/graph/cell/cellModel";
import {
  type GraphCellOperation,
  GraphCellQueue,
  type GraphCellSubmitOptions,
} from "../src/graph/cell/cellQueue";
import { makeGraphCellQueueRegistry } from "../src/graph/cell/queueRegistry";
import { runEffectEdge } from "../src/graph/driverExecution/effectRunner";
import { makeGraphJobQueue } from "../src/graph/queue/jobQueue";

function makeQueue() {
  return Effect.sync(() => new GraphCellQueue(makeGraphJobQueue()));
}

/** An operation whose work is one Effect, interrupted alongside its interrupt as an Effect worker. */
interface EffectOperation<A> {
  readonly effect: Effect.Effect<A>;
  readonly interrupt?: GraphCellOperation<A>["interrupt"];
}

function fromEffect<A>(operation: EffectOperation<A>): GraphCellOperation<A> {
  return {
    start: (context, resume) => runEffectEdge(operation.effect, context, resume),
    interrupt: operation.interrupt,
    interruptsWorkAlongside: true,
  };
}

function submit<A>(
  queue: GraphCellQueue,
  operation: EffectOperation<A>,
  options?: GraphCellSubmitOptions
) {
  return Effect.withFiber((fiber) =>
    Effect.sync(() => queue.submitSync(fromEffect(operation), fiber.context, options))
  );
}

describe("graph cell queue", () => {
  test("registry close race settles through the closed-queue interruption outcome", async () => {
    const registry = makeGraphCellQueueRegistry(makeGraphJobQueue());
    const cell = {
      nodeId: "test:closed-registry" as NodeId,
      tag: "test/closed-registry",
    } as unknown as GraphNodeCell;
    let effectRuns = 0;

    registry.closeForShutdown();
    const task = registry.submitSync(
      cell,
      fromEffect<
        | { readonly _tag: "Success" }
        | { readonly _tag: "Failure"; readonly reason: RuntimeCancellationReason | undefined }
      >({
        effect: Effect.sync(() => {
          effectRuns += 1;
          return { _tag: "Success" } as const;
        }),
        interrupt: (reason) =>
          Effect.succeed({
            _tag: "Failure",
            reason,
          } as const),
      }),
      Context.empty()
    );
    const result = await Effect.runPromise(task.await);

    expect(result).toEqual({
      _tag: "Failure",
      reason: {
        _tag: "Released",
        detail: "graph cell is closed",
      },
    });
    expect(effectRuns).toBe(0);
    expect(registry.queues.size).toBe(0);
  });

  test("awaiting the same task sequentially runs the operation once", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cellQueue = yield* makeQueue();
        let runs = 0;
        const task = yield* submit(cellQueue, {
          effect: Effect.sync(() => {
            runs += 1;
            return runs;
          }),
        });

        const first = yield* task.await;
        const second = yield* task.await;
        return { first, second, runs };
      })
    );

    expect(result).toEqual({ first: 1, second: 1, runs: 1 });
  });

  test("awaiting the same task concurrently runs the operation once", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cellQueue = yield* makeQueue();
        const gate = yield* Deferred.make<number>();
        let runs = 0;
        const task = yield* submit(cellQueue, {
          effect: Effect.gen(function* () {
            runs += 1;
            return yield* Deferred.await(gate);
          }),
        });
        const first = yield* task.await.pipe(Effect.forkDetach);
        const second = yield* task.await.pipe(Effect.forkDetach);

        yield* Deferred.succeed(gate, 42).pipe(Effect.asVoid);
        return {
          first: yield* Fiber.join(first),
          second: yield* Fiber.join(second),
          runs,
        };
      })
    );

    expect(result).toEqual({ first: 42, second: 42, runs: 1 });
  });

  test("interrupting one awaiter does not release cell serialization", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cellQueue = yield* makeQueue();
        const firstStarted = yield* Deferred.make<void>();
        const firstGate = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const firstTask = yield* submit(cellQueue, {
          effect: Effect.gen(function* () {
            events.push("first-start");
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(firstGate);
            events.push("first-end");
            return "first";
          }),
        });
        const firstAwaiter = yield* firstTask.await.pipe(Effect.forkDetach);

        yield* Deferred.await(firstStarted);
        yield* Fiber.interrupt(firstAwaiter);

        const secondTask = yield* submit(cellQueue, {
          effect: Effect.gen(function* () {
            events.push("second-start");
            yield* Deferred.succeed(secondStarted, undefined);
            return "second";
          }),
        });

        yield* Deferred.await(secondStarted).pipe(
          Effect.timeout("20 millis"),
          Effect.match({
            onFailure: () => undefined,
            onSuccess: () => undefined,
          })
        );
        const beforeRelease = [...events];
        yield* Deferred.succeed(firstGate, undefined).pipe(Effect.asVoid);
        const second = yield* secondTask.await;
        return { beforeRelease, events, second };
      })
    );

    expect(result.beforeRelease).toEqual(["first-start"]);
    expect(result.events).toEqual(["first-start", "first-end", "second-start"]);
    expect(result.second).toBe("second");
  });

  test("explicit interruption is idempotent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cellQueue = yield* makeQueue();
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let interrupts = 0;
        const operation: EffectOperation<string> = {
          effect: Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return "done";
          }),
          interrupt: (reason) => {
            void reason;
            interrupts += 1;
            return Effect.succeed("interrupted");
          },
        };

        const task = yield* submit(cellQueue, operation);
        yield* Deferred.await(started);
        yield* cellQueue.close({ _tag: "Released", detail: "test" });
        yield* cellQueue.close({ _tag: "Released", detail: "test again" });
        return { value: yield* task.await, interrupts };
      })
    );

    expect(result).toEqual({ value: "interrupted", interrupts: 1 });
  });

  test("shutdown interrupts active work before cleanup", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cellQueue = yield* makeQueue();
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const task = yield* submit(cellQueue, {
          effect: Effect.gen(function* () {
            events.push("start");
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return "done";
          }),
          interrupt: (reason) => {
            void reason;
            events.push("interrupt");
            return Effect.succeed("interrupted");
          },
        });

        yield* Deferred.await(started);
        const cleanup = yield* cellQueue.shutdown({
          reason: { _tag: "RuntimeStopped" },
          cleanup: Effect.sync(() => {
            events.push("cleanup");
            return "cleaned";
          }),
        });

        return { value: yield* task.await, cleanup, events };
      })
    );

    expect(result).toEqual({
      value: "interrupted",
      cleanup: "cleaned",
      events: ["start", "interrupt", "cleanup"],
    });
  });

  test("shutdown settles queued task replies", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cellQueue = yield* makeQueue();
        const firstStarted = yield* Deferred.make<void>();
        const firstGate = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const makeOperation = (label: string): EffectOperation<string> => ({
          effect: Effect.gen(function* () {
            events.push(`${label}:start`);
            if (label === "first") {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(firstGate);
            }
            return `${label}:done`;
          }),
          interrupt: (reason) => {
            events.push(`${label}:interrupt:${reason?._tag ?? "none"}`);
            return Effect.succeed(`${label}:interrupted`);
          },
        });

        const first = yield* submit(cellQueue, makeOperation("first"));
        const second = yield* submit(cellQueue, makeOperation("second"));
        const third = yield* submit(cellQueue, makeOperation("third"));

        yield* Deferred.await(firstStarted);
        const cleanup = yield* cellQueue.shutdown({
          reason: { _tag: "RuntimeStopped" },
          cleanup: Effect.succeed("cleanup"),
        });

        return {
          first: yield* first.await.pipe(Effect.timeout("200 millis")),
          second: yield* second.await.pipe(Effect.timeout("200 millis")),
          third: yield* third.await.pipe(Effect.timeout("200 millis")),
          cleanup,
          events,
        };
      })
    );

    expect(result).toEqual({
      first: "first:interrupted",
      second: "second:interrupted",
      third: "third:interrupted",
      cleanup: "cleanup",
      events: [
        "first:start",
        "first:interrupt:RuntimeStopped",
        "second:interrupt:RuntimeStopped",
        "third:interrupt:RuntimeStopped",
      ],
    });
  });

  test("throwing onComplete does not prevent reply settlement", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cellQueue = yield* makeQueue();
        const task = yield* submit(
          cellQueue,
          {
            effect: Effect.succeed("done"),
          },
          {
            onComplete: () => {
              throw new Error("cleanup failed");
            },
          }
        );

        return yield* task.await.pipe(Effect.timeout("200 millis"));
      })
    );

    expect(result).toBe("done");
  });
});

test("cell work and a nested submission run only from the shared microtask queue", async () => {
  const jobs = makeGraphJobQueue();
  const queue = new GraphCellQueue(jobs);
  const events: string[] = [];
  let nested: import("../src/graph/cell/cellQueue").GraphCellTask<void> | undefined;
  const first = queue.submitSync(
    fromEffect({
      effect: Effect.sync(() => {
        events.push("first");
        nested = queue.submitSync(
          fromEffect({
            effect: Effect.sync(() => {
              events.push("nested");
            }),
          }),
          Context.empty()
        );
        expect(events).toEqual(["first"]);
      }),
    }),
    Context.empty()
  );
  expect(events).toEqual([]);
  await Effect.runPromise(first.await);
  if (nested === undefined) throw new Error("nested task missing");
  await Effect.runPromise(nested.await);
  expect(events).toEqual(["first", "nested"]);
});

test("the exclusive gate holds through interrupted release finalizers", async () => {
  const { GraphGate } = await import("../src/graph/queue/graphGate");
  const gate = new GraphGate(makeGraphJobQueue());
  const started = Deferred.makeUnsafe<void>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const cleanupGate = Deferred.makeUnsafe<void>();
  const fiber = Effect.runFork(
    gate.run(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(cleanupStarted, undefined);
            yield* Deferred.await(cleanupGate);
          })
        )
      )
    )
  );
  await Effect.runPromise(Deferred.await(started));
  let planned = false;
  const waiting = Effect.runPromise(
    gate.plan(() => {
      planned = true;
    })
  );
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  await Effect.runPromise(Deferred.await(cleanupStarted));
  expect(planned).toBe(false);
  await Effect.runPromise(Deferred.succeed(cleanupGate, undefined));
  await interrupted;
  await waiting;
  expect(planned).toBe(true);
});

test("interrupting a shutdown caller interrupts its cleanup and waits for the cleanup's finalizers", async () => {
  const queue = new GraphCellQueue(makeGraphJobQueue());
  const events: string[] = [];
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const finalizerGate = Deferred.makeUnsafe<void>();
  const shutdown = Effect.runFork(
    queue.shutdown({
      reason: { _tag: "RuntimeStopped" },
      cleanup: Effect.gen(function* () {
        events.push("cleanup:start");
        yield* Deferred.succeed(cleanupStarted, undefined);
        return yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            events.push("cleanup:interrupted");
            yield* Deferred.await(finalizerGate);
            events.push("cleanup:finalized");
          })
        )
      ),
    })
  );
  await Effect.runPromise(Deferred.await(cleanupStarted));
  const interrupted = Effect.runPromise(Fiber.interrupt(shutdown)).then(() => {
    events.push("caller:interrupted");
  });
  await Effect.runPromise(Effect.yieldNow);
  expect(events).toEqual(["cleanup:start", "cleanup:interrupted"]);
  await Effect.runPromise(Deferred.succeed(finalizerGate, undefined));
  await interrupted;
  const exit = await Effect.runPromise(Fiber.await(shutdown));
  expect(Exit.hasInterrupts(exit)).toBe(true);
  expect(events).toEqual([
    "cleanup:start",
    "cleanup:interrupted",
    "cleanup:finalized",
    "caller:interrupted",
  ]);
  expect(queue.isIdle).toBe(true);
});

test("an exclusive run interrupted while it waits never runs and holds its caller until its turn", async () => {
  const { GraphGate } = await import("../src/graph/queue/graphGate");
  const gate = new GraphGate(makeGraphJobQueue());
  const events: string[] = [];
  const firstStarted = Deferred.makeUnsafe<void>();
  const firstGate = Deferred.makeUnsafe<void>();
  const first = Effect.runFork(
    gate.run(
      Effect.gen(function* () {
        yield* Deferred.succeed(firstStarted, undefined);
        yield* Deferred.await(firstGate);
        events.push("first:end");
      })
    )
  );
  await Effect.runPromise(Deferred.await(firstStarted));
  const second = Effect.runFork(
    gate.run(
      Effect.sync(() => {
        events.push("second:run");
      })
    )
  );
  await Effect.runPromise(Effect.yieldNow);
  const interrupted = Effect.runPromise(Fiber.interrupt(second)).then(() => {
    events.push("second:interrupted");
  });
  await Effect.runPromise(Effect.yieldNow);
  expect(events).toEqual([]);
  await Effect.runPromise(Deferred.succeed(firstGate, undefined));
  await Effect.runPromise(Fiber.join(first));
  await interrupted;
  expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(second)))).toBe(true);
  let planned = false;
  await Effect.runPromise(
    gate.plan(() => {
      planned = true;
    })
  );
  expect(planned).toBe(true);
  expect(events).toEqual(["first:end", "second:interrupted"]);
});
