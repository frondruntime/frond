import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import type { NodeId } from "../src/graph";
import { makeGraphCellActorRegistry } from "../src/graph/cell/actorRegistry";
import {
  type GraphCellOperation,
  interruptCellOperation,
  makeGraphCellActor,
} from "../src/graph/cell/cellActor";
import type { GraphNodeCell } from "../src/graph/cell/cellModel";

describe("graph cell actor", () => {
  test("registry close race settles through the closed-actor interruption outcome", async () => {
    const registry = makeGraphCellActorRegistry();
    const cell = {
      nodeId: "test:closed-registry" as NodeId,
      tag: "test/closed-registry",
    } as unknown as GraphNodeCell;
    let effectRuns = 0;

    await Effect.runPromise(registry.closeForShutdown());
    const task = await Effect.runPromise(
      registry.submit(cell, {
        effect: Effect.sync(() => {
          effectRuns += 1;
          return { _tag: "Success" } as const;
        }),
        interrupt: (reply, reason) =>
          Deferred.succeed(reply, {
            _tag: "Failure",
            reason,
          } as const).pipe(Effect.asVoid),
      })
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
    expect(registry.actors.size).toBe(0);
  });

  test("awaiting the same task sequentially runs the operation once", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* makeGraphCellActor();
        let runs = 0;
        const task = yield* actor.submit({
          effect: Effect.sync(() => {
            runs += 1;
            return runs;
          }),
          interrupt: interruptCellOperation,
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
        const actor = yield* makeGraphCellActor();
        const gate = yield* Deferred.make<number>();
        let runs = 0;
        const task = yield* actor.submit({
          effect: Effect.gen(function* () {
            runs += 1;
            return yield* Deferred.await(gate);
          }),
          interrupt: interruptCellOperation,
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
        const actor = yield* makeGraphCellActor();
        const firstStarted = yield* Deferred.make<void>();
        const firstGate = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const firstTask = yield* actor.submit({
          effect: Effect.gen(function* () {
            events.push("first-start");
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(firstGate);
            events.push("first-end");
            return "first";
          }),
          interrupt: interruptCellOperation,
        });
        const firstAwaiter = yield* firstTask.await.pipe(Effect.forkDetach);

        yield* Deferred.await(firstStarted);
        yield* Fiber.interrupt(firstAwaiter);

        const secondTask = yield* actor.submit({
          effect: Effect.gen(function* () {
            events.push("second-start");
            yield* Deferred.succeed(secondStarted, undefined);
            return "second";
          }),
          interrupt: interruptCellOperation,
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
        const actor = yield* makeGraphCellActor();
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let interrupts = 0;
        const operation: GraphCellOperation<string> = {
          effect: Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return "done";
          }),
          interrupt: (reply, reason) => {
            void reason;
            interrupts += 1;
            return Deferred.succeed(reply, "interrupted").pipe(Effect.asVoid);
          },
        };

        const task = yield* actor.submit(operation);
        yield* Deferred.await(started);
        yield* actor.close({ _tag: "Released", detail: "test" });
        yield* actor.close({ _tag: "Released", detail: "test again" });
        return { value: yield* task.await, interrupts };
      })
    );

    expect(result).toEqual({ value: "interrupted", interrupts: 1 });
  });

  test("shutdown interrupts active work before cleanup", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* makeGraphCellActor();
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const task = yield* actor.submit({
          effect: Effect.gen(function* () {
            events.push("start");
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return "done";
          }),
          interrupt: (reply, reason) => {
            void reason;
            events.push("interrupt");
            return Deferred.succeed(reply, "interrupted").pipe(Effect.asVoid);
          },
        });

        yield* Deferred.await(started);
        const cleanup = yield* actor.shutdown({
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
        const actor = yield* makeGraphCellActor();
        const firstStarted = yield* Deferred.make<void>();
        const firstGate = yield* Deferred.make<void>();
        const events: Array<string> = [];
        const makeOperation = (label: string): GraphCellOperation<string> => ({
          effect: Effect.gen(function* () {
            events.push(`${label}:start`);
            if (label === "first") {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(firstGate);
            }
            return `${label}:done`;
          }),
          interrupt: (reply, reason) => {
            events.push(`${label}:interrupt:${reason?._tag ?? "none"}`);
            return Deferred.succeed(reply, `${label}:interrupted`).pipe(Effect.asVoid);
          },
        });

        const first = yield* actor.submit(makeOperation("first"));
        const second = yield* actor.submit(makeOperation("second"));
        const third = yield* actor.submit(makeOperation("third"));

        yield* Deferred.await(firstStarted);
        const cleanup = yield* actor.shutdown({
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
        const actor = yield* makeGraphCellActor();
        const task = yield* actor.submit(
          {
            effect: Effect.succeed("done"),
            interrupt: interruptCellOperation,
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
