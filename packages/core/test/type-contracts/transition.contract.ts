import type * as Frond from "@frondruntime/core";
import { Effect } from "effect";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

// The outcome shape is pinned: labels in order, failures as data, ok flag.
export type TransitionOutcomeShape = Expect<
  Equal<
    Frond.TransitionOutcome,
    Readonly<{
      completed: ReadonlyArray<string>;
      failures: ReadonlyArray<Readonly<{ label: string; cause: unknown }>>;
      ok: boolean;
    }>
  >
>;

// Both entry points resolve to the outcome, never throw-typed.
export type RunTransitionReturnsOutcome = Expect<
  Equal<ReturnType<typeof Frond.runTransition>, Promise<Frond.TransitionOutcome>>
>;
export type CreatedTransitionReturnsOutcome = Expect<
  Equal<ReturnType<typeof Frond.createTransition>, () => Promise<Frond.TransitionOutcome>>
>;

// Steps accept a Promise thunk and an Effect thunk alike.
const promiseStep = {
  label: "promise",
  run: () => Promise.resolve("done"),
} satisfies Frond.TransitionStep<string>;

const effectStep = {
  label: "effect",
  run: () => Effect.succeed(42),
} satisfies Frond.TransitionStep<number>;

// Heterogeneous step lists collapse to the default TransitionStep.
[promiseStep, effectStep] satisfies ReadonlyArray<Frond.TransitionStep>;

// The failure policy is a closed union.
({ onStepFailure: "abort" }) satisfies Frond.TransitionOptions;
({ onStepFailure: "continue" }) satisfies Frond.TransitionOptions;
export type FailurePolicyIsClosed = Expect<
  Equal<Frond.TransitionOptions["onStepFailure"], "abort" | "continue">
>;
