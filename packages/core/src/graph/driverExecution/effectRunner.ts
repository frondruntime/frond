import { type Cause, type Context, Effect } from "effect";
import type { GraphJobQueue } from "../queue/jobQueue";
import { forkIn, type GraphCancel, type GraphResume } from "../queue/reply";
import { reportCause } from "./causePolicy";

/** Execute remaining Effect edge work, preserving the facade's services. */
export function runEffectEdge<A, E>(
  effect: Effect.Effect<A, E>,
  context: Context.Context<never> | undefined,
  resume: GraphResume<A, E>
): GraphCancel {
  const fiber = forkIn(context, effect);
  fiber.addObserver(resume);
  return () =>
    Effect.callback((done) => {
      fiber.addObserver(() => done(Effect.void));
      fiber.interruptUnsafe();
    });
}

/**
 * Runs observer work, then `next`. The shared void sentinel keeps plain
 * observers entirely outside Effect and returns `undefined`; Effect work (a
 * sink) returns the cancel that interrupts it and awaits its finalizers.
 *
 * A sink that fails on its own reports its cause as a throwing graph job, the
 * host's uncaught-error path. A sink interrupted by its cancel or by
 * `interruptObserverWork` always runs `next`, whatever its finalizers did, so
 * the operation or caller waiting behind it is never stranded; as in 0.5, its
 * exit is not reported. The fiber observer itself never throws: Effect runs
 * observers in a plain loop, so a throw would skip the ones behind it.
 */
export function finishObserverWork(
  effect: Effect.Effect<void> | void,
  context: Context.Context<never> | undefined,
  next: () => void,
  jobs: GraphJobQueue
): GraphCancel | undefined {
  return runObserverWork(effect, context, next, jobs, undefined);
}

/** The step a sink belongs to, which ends with the sink's own failure. */
export interface ObserverWorkOwner {
  failCause(cause: Cause.Cause<never>): void;
}

/**
 * As `finishObserverWork`, except that the sink belongs to `owner`, as a
 * notice inside an Effect pipeline did: a sink that ends on its own runs
 * `next` on success, or `owner.failCause` with its cause when it fails, dies,
 * or interrupts itself, in the turn it ends; no cancel is returned for a sink
 * that ended before it returns. Neither continuation may throw.
 */
export function finishObserverWorkInTurn(
  effect: Effect.Effect<void> | void,
  context: Context.Context<never> | undefined,
  next: () => void,
  owner: ObserverWorkOwner,
  jobs: GraphJobQueue
): GraphCancel | undefined {
  return runObserverWork(effect, context, next, jobs, owner);
}

function runObserverWork(
  effect: Effect.Effect<void> | void,
  context: Context.Context<never> | undefined,
  next: () => void,
  jobs: GraphJobQueue,
  owner: ObserverWorkOwner | undefined
): GraphCancel | undefined {
  if (effect === undefined || effect === Effect.void) {
    next();
    return undefined;
  }
  const running = jobs.observerFibers;
  const fiber = forkIn(context, effect);
  running.add(fiber);
  let ended = false;
  fiber.addObserver((exit) => {
    ended = true;
    if (!running.delete(fiber)) {
      jobs.post({ run: next });
      return;
    }
    if (owner === undefined) {
      if (exit._tag === "Failure") reportCause(jobs, exit.cause);
      else jobs.post({ run: next });
      return;
    }
    switch (exit._tag) {
      case "Success":
        next();
        return;
      case "Failure":
        owner.failCause(exit.cause);
        return;
    }
  });
  if (owner !== undefined && ended) return undefined;
  return () =>
    Effect.callback((done) => {
      running.delete(fiber);
      fiber.addObserver(() => done(Effect.void));
      fiber.interruptUnsafe();
    });
}

/**
 * Interrupts every observer fiber still running on `jobs` and runs `done` once
 * their finalizers have run and their continuations are posted.
 */
export function interruptObserverWork(jobs: GraphJobQueue, done: () => void): void {
  const fibers = jobs.observerFibers;
  if (fibers.size === 0) {
    done();
    return;
  }
  const interrupted = Array.from(fibers);
  fibers.clear();
  let remaining = interrupted.length;
  const finished = () => {
    remaining -= 1;
    if (remaining === 0) jobs.post({ run: done });
  };
  // Every fiber is awaited before any is interrupted: an interruption runs
  // finalizers and observers synchronously, and must not skip the fibers
  // behind it.
  for (const fiber of interrupted) fiber.addObserver(finished);
  for (const fiber of interrupted) fiber.interruptUnsafe();
}
