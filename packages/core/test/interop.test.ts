import { describe, expect, test } from "bun:test";
import { Cause, Effect, Fiber } from "effect";
import { unwrapEffect, wrapPromise } from "../src";

class TimezoneRejected extends Error {
  readonly _tag = "TimezoneRejected";

  constructor() {
    super("timezone rejected");
    this.name = "TimezoneRejected";
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected the promise to reject");
  } catch (cause) {
    return cause;
  }
}

describe("interop", () => {
  test("unwrapEffect rejects a typed failure as the original error", async () => {
    const failure = new TimezoneRejected();

    const rejection = await rejectionOf(unwrapEffect(Effect.fail(failure)));

    expect(rejection).toBeInstanceOf(TimezoneRejected);
    expect(rejection).toBe(failure);
  });

  test("unwrapEffect does not surface a defect as the raw thrown value", async () => {
    const defect = new TimezoneRejected();

    const rejection = await rejectionOf(
      unwrapEffect(
        Effect.sync(() => {
          throw defect;
        })
      )
    );

    // Defects reject with the failure cause so they stay distinguishable from a
    // typed failure; the raw thrown value stays inside the cause.
    expect(rejection).not.toBe(defect);
    expect(rejection instanceof TimezoneRejected).toBe(false);
    expect(Cause.isCause(rejection)).toBe(true);
  });

  test("wrapPromise round-trips an unwrapEffect typed failure into the error channel intact", async () => {
    const failure = new TimezoneRejected();
    const effect = Effect.fail(failure);

    const roundTripped = await Effect.runPromise(
      Effect.flip(wrapPromise(() => unwrapEffect(effect)))
    );

    expect(roundTripped).toBeInstanceOf(TimezoneRejected);
    expect(roundTripped).toBe(failure);
  });

  test("interrupting a wrapPromise-wrapped Effect fires the AbortSignal", async () => {
    let aborted = false;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const fiber = Effect.runFork(
      wrapPromise(
        (signal) =>
          new Promise<never>(() => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            markStarted();
          })
      )
    );

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(aborted).toBe(true);
  });
});
