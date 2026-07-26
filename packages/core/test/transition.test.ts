import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createTransition, runTransition, type TransitionStep } from "../src";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function step(label: string, log: string[], work?: () => Promise<unknown>): TransitionStep {
  return {
    label,
    run: async () => {
      log.push(`${label}:begin`);
      if (work !== undefined) {
        await work();
      }
      log.push(`${label}:end`);
      return label;
    },
  };
}

function failingStep(label: string, log: string[], cause: unknown): TransitionStep {
  return {
    label,
    run: async () => {
      log.push(`${label}:begin`);
      throw cause;
    },
  };
}

describe("runTransition", () => {
  test("runs steps strictly in order and reports every label as completed", async () => {
    const log: string[] = [];
    const gate = deferred<void>();
    const steps = [
      step("revoke", log, () => gate.promise),
      step("clear-cache", log),
      step("redirect", log),
    ];

    const pending = runTransition(steps, { onStepFailure: "abort" });
    // The first step is gated; later steps must not have started.
    await Promise.resolve();
    expect(log).toEqual(["revoke:begin"]);
    gate.resolve(undefined);

    const outcome = await pending;
    expect(log).toEqual([
      "revoke:begin",
      "revoke:end",
      "clear-cache:begin",
      "clear-cache:end",
      "redirect:begin",
      "redirect:end",
    ]);
    expect(outcome).toEqual({
      completed: ["revoke", "clear-cache", "redirect"],
      failures: [],
      ok: true,
    });
  });

  test("abort stops at the first failure; skipped steps appear in neither array", async () => {
    const log: string[] = [];
    const boom = new Error("revoke failed");
    const steps = [
      step("flush", log),
      failingStep("revoke", log, boom),
      step("clear-cache", log),
      step("redirect", log),
    ];

    const outcome = await runTransition(steps, { onStepFailure: "abort" });

    expect(log).toEqual(["flush:begin", "flush:end", "revoke:begin"]);
    expect(outcome.completed).toEqual(["flush"]);
    expect(outcome.failures).toEqual([{ label: "revoke", cause: boom }]);
    expect(outcome.ok).toBe(false);
  });

  test("continue collects multiple failures and still runs the tail", async () => {
    const log: string[] = [];
    const first = new Error("revoke failed");
    const second = new Error("clear-cache failed");
    const steps = [
      failingStep("revoke", log, first),
      step("drop-session", log),
      failingStep("clear-cache", log, second),
      step("redirect", log),
    ];

    const outcome = await runTransition(steps, { onStepFailure: "continue" });

    expect(log).toEqual([
      "revoke:begin",
      "drop-session:begin",
      "drop-session:end",
      "clear-cache:begin",
      "redirect:begin",
      "redirect:end",
    ]);
    expect(outcome.completed).toEqual(["drop-session", "redirect"]);
    expect(outcome.failures).toEqual([
      { label: "revoke", cause: first },
      { label: "clear-cache", cause: second },
    ]);
    expect(outcome.ok).toBe(false);
  });

  test("mixed Promise and Effect steps run in order; Effect failures surface the typed error", async () => {
    const log: string[] = [];
    const effectError = new Error("effect step failed");
    const steps: ReadonlyArray<TransitionStep> = [
      step("promise-ok", log),
      {
        label: "effect-ok",
        run: () =>
          Effect.sync(() => {
            log.push("effect-ok:run");
            return 42;
          }),
      },
      {
        label: "effect-fail",
        run: () => Effect.fail(effectError),
      },
      step("promise-tail", log),
    ];

    const outcome = await runTransition(steps, { onStepFailure: "continue" });

    expect(log).toEqual([
      "promise-ok:begin",
      "promise-ok:end",
      "effect-ok:run",
      "promise-tail:begin",
      "promise-tail:end",
    ]);
    expect(outcome.completed).toEqual(["promise-ok", "effect-ok", "promise-tail"]);
    expect(outcome.failures).toEqual([{ label: "effect-fail", cause: effectError }]);
    expect(outcome.ok).toBe(false);
  });
});

describe("createTransition", () => {
  test("concurrent calls join the in-flight run; a later call runs fresh", async () => {
    let runs = 0;
    const gate = deferred<void>();
    let currentGate = gate.promise;
    const transition = createTransition(
      [
        {
          label: "only",
          run: async () => {
            runs += 1;
            await currentGate;
          },
        },
      ],
      { onStepFailure: "abort" }
    );

    const a = transition();
    const b = transition();
    const c = transition();
    expect(b).toBe(a);
    expect(c).toBe(a);

    gate.resolve(undefined);
    const [outcomeA, outcomeB] = await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(outcomeA.ok).toBe(true);
    expect(outcomeB).toBe(outcomeA);

    currentGate = Promise.resolve();
    const fresh = transition();
    expect(fresh).not.toBe(a);
    await fresh;
    expect(runs).toBe(2);
  });

  test("a failed run does not poison the next call", async () => {
    let attempts = 0;
    const transition = createTransition(
      [
        {
          label: "flaky",
          run: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("first attempt fails");
            }
          },
        },
      ],
      { onStepFailure: "abort" }
    );

    const first = await transition();
    expect(first.ok).toBe(false);
    expect(first.failures).toHaveLength(1);

    const second = await transition();
    expect(second).toEqual({ completed: ["flaky"], failures: [], ok: true });
    expect(attempts).toBe(2);
  });
});
