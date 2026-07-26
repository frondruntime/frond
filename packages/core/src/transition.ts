/**
 * Minimal ordered-transition helper for multi-node flows (sign-out, session
 * expiry): run a fixed list of labeled steps strictly in order, apply one
 * failure policy, and report what happened as data.
 *
 * Scope is deliberately hard-capped at: ordered execution + failure policy +
 * result record + single-flight. NO per-step timeouts, NO compensation or
 * rollback, NO resumability, NO step graphs — those belong to the
 * node-owned-workflows proposal (0.3.0).
 */

import { Effect } from "effect";
import { unwrapEffect } from "./interop";

/**
 * One labeled unit of a transition. `run` may return a Promise (async-mode
 * handle actions, plain async work) or a self-contained Effect (effect-mode
 * handle actions); both execute identically via the `unwrapEffect` interop.
 */
export type TransitionStep<A = unknown> = Readonly<{
  /** Names the step in the outcome record and diagnostics. */
  label: string;
  /** Produces the step's work; invoked once per transition run. */
  run: () => Promise<A> | Effect.Effect<A, unknown>;
}>;

/**
 * How a transition reacts to a failed step: `"abort"` stops at the first
 * failure and skips the remaining steps; `"continue"` runs every step and
 * collects each failure (the best-effort tail).
 */
export type TransitionOptions = Readonly<{
  onStepFailure: "abort" | "continue";
}>;

/**
 * The result record of a transition run. Failures are data — a transition
 * never rejects. Steps skipped by an `"abort"` appear in neither array.
 */
export type TransitionOutcome = Readonly<{
  /** Labels of the steps that succeeded, in execution order. */
  completed: ReadonlyArray<string>;
  /** Each failed step's label and the value it rejected or failed with. */
  failures: ReadonlyArray<Readonly<{ label: string; cause: unknown }>>;
  /** `true` exactly when `failures` is empty. */
  ok: boolean;
}>;

const settleStep = async (step: TransitionStep): Promise<unknown> => {
  const work = step.run();
  return Effect.isEffect(work) ? unwrapEffect(work as Effect.Effect<unknown, unknown>) : work;
};

/**
 * Runs `steps` strictly sequentially and reports the outcome as data.
 *
 * With `onStepFailure: "abort"` the first failure stops the run — remaining
 * steps are not invoked and their labels appear in neither outcome array.
 * With `"continue"` every step runs and every failure is collected, which is
 * the best-effort tail that sign-out flows hand-roll. The returned Promise
 * never rejects; inspect `outcome.ok` and `outcome.failures`.
 */
export async function runTransition(
  steps: ReadonlyArray<TransitionStep>,
  opts: TransitionOptions
): Promise<TransitionOutcome> {
  const completed: string[] = [];
  const failures: Array<{ label: string; cause: unknown }> = [];

  for (const step of steps) {
    try {
      await settleStep(step);
      completed.push(step.label);
    } catch (cause) {
      failures.push({ label: step.label, cause });
      if (opts.onStepFailure === "abort") {
        break;
      }
    }
  }

  return { completed, failures, ok: failures.length === 0 };
}

/**
 * Wraps `runTransition` in a single-flight invoker: concurrent calls join the
 * in-flight run (the steps execute once), and once that run settles a new
 * call starts a fresh run. The in-flight Promise is the only memo — there is
 * no generation counter and no superseding, unlike the runtime coordinator.
 */
export function createTransition(
  steps: ReadonlyArray<TransitionStep>,
  opts: TransitionOptions
): () => Promise<TransitionOutcome> {
  let inFlight: Promise<TransitionOutcome> | undefined;

  return () => {
    if (inFlight !== undefined) {
      return inFlight;
    }
    const run = runTransition(steps, opts);
    inFlight = run;
    const clear = () => {
      if (inFlight === run) {
        inFlight = undefined;
      }
    };
    run.then(clear, clear);
    return run;
  };
}
