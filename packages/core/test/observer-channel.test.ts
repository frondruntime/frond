import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { makeObserverChannel } from "../src/graph/system/observerChannel";

type Observer = (value: number) => void | Effect.Effect<void>;

function makeChannel(reportFailure?: (cause: unknown) => Effect.Effect<void>) {
  return makeObserverChannel<Observer, [number]>({
    channel: "node-change",
    reportFailure: ({ cause }) => reportFailure?.(cause) ?? Effect.void,
  });
}

describe("synchronous observer channel", () => {
  test("notifies inline from a stable snapshot and applies subscription changes to later calls", () => {
    const channel = makeChannel();
    const calls: string[] = [];
    let removeSecond = () => {};
    const late: Observer = (value) => {
      calls.push(`late:${value}`);
    };
    Effect.runSync(
      channel.subscribe((value) => {
        calls.push(`first:${value}`);
        removeSecond();
        Effect.runSync(channel.subscribe(late));
        return Effect.void;
      })
    );
    removeSecond = Effect.runSync(
      channel.subscribe((value) => {
        calls.push(`second:${value}`);
        return Effect.void;
      })
    ).unsubscribe;

    expect(channel.notifyAll(1)).toBe(Effect.void);
    expect(calls).toEqual(["first:1", "second:1"]);
    calls.length = 0;
    channel.notifyAll(2);
    expect(calls).toEqual(["first:2", "late:2"]);
  });

  test("isolates thrown observers and failure reporters and continues synchronously", () => {
    const failure = new Error("observer threw");
    const causes: unknown[] = [];
    const channel = makeChannel((cause) => {
      causes.push(cause);
      throw new Error("failure reporter threw");
    });
    let delivered = 0;
    Effect.runSync(
      channel.subscribe(() => {
        throw failure;
      })
    );
    Effect.runSync(
      channel.subscribe(() => {
        delivered += 1;
        return Effect.void;
      })
    );

    expect(channel.notifyAll(1)).toBe(Effect.void);
    expect(causes).toEqual([failure]);
    expect(delivered).toBe(1);
  });

  test("awaits existing Effect observers in order with the original snapshot and isolates failures", async () => {
    const gate = Deferred.makeUnsafe<void>();
    const started = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    const channel = makeChannel(() =>
      Effect.sync(() => {
        calls.push("reported");
      })
    );
    Effect.runSync(
      channel.subscribe(() =>
        Effect.gen(function* () {
          calls.push("first");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(gate);
          return yield* Effect.die("observer defect");
        })
      )
    );
    const second = Effect.runSync(
      channel.subscribe(() => {
        calls.push("second");
        return Effect.void;
      })
    );
    const pending = Effect.runPromise(channel.notifyAll(1));
    await Effect.runPromise(Deferred.await(started));
    second.unsubscribe();
    Effect.runSync(
      channel.subscribe(() => {
        calls.push("late");
        return Effect.void;
      })
    );
    expect(calls).toEqual(["first"]);
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await pending;
    expect(calls).toEqual(["first", "reported", "second"]);
  });
});
