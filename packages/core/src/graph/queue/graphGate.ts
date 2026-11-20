import { type Context, Effect, Exit, type Fiber } from "effect";
import type { GraphJob, GraphJobQueue } from "./jobQueue";
import { callbackEffect, type GraphCancel, GraphReply, type GraphResume } from "./reply";

interface GateEntry extends GraphJob {
  readonly exclusive: boolean;
}

/** Async release owns the gate; waiting submissions plan only after it exits. */
export class GraphGate {
  private exclusiveInFlight = false;
  private exclusivePosted = 0;
  private plansPosted = 0;
  private readonly waiting: GateEntry[] = [];

  constructor(readonly jobs: GraphJobQueue) {}

  plan<A>(
    plan: (context: Context.Context<never> | undefined) => A,
    reserve = false
  ): Effect.Effect<A> {
    return callbackEffect((context, resume) => this.planDirect(plan, context, resume, reserve));
  }

  planDirect<A>(
    plan: (context: Context.Context<never> | undefined) => A,
    context: Context.Context<never> | undefined,
    resume: GraphResume<A>,
    reserve = false
  ): GraphCancel {
    const entry = new PlanEntry(plan, context, resume);
    if (reserve && this.exclusivePosted === 0 && this.plansPosted === 0) entry.run();
    else {
      this.plansPosted += 1;
      this.post(entry);
    }
    return () => {
      entry.canceled = true;
      return Effect.void;
    };
  }

  run<A>(effect: Effect.Effect<A>): Effect.Effect<A> {
    return Effect.withFiber((fiber) =>
      Effect.callback((resume) => {
        this.exclusivePosted += 1;
        const entry = new ExclusiveEntry(this, effect, fiber.context, resume);
        this.post(entry);
        return Effect.suspend(() => entry.interrupt());
      })
    );
  }

  private post(entry: GateEntry): void {
    this.jobs.post(new GateJob(this, entry));
  }

  accept(entry: GateEntry): void {
    if (this.exclusiveInFlight) this.waiting.push(entry);
    else this.start(entry);
  }

  private start(entry: GateEntry): void {
    if (!entry.exclusive) this.plansPosted -= 1;
    this.exclusiveInFlight = entry.exclusive;
    entry.run();
  }

  finish(): void {
    this.exclusiveInFlight = false;
    this.exclusivePosted -= 1;
    while (!this.exclusiveInFlight && this.waiting.length > 0) {
      const entry = this.waiting.shift();
      if (entry !== undefined) this.start(entry);
    }
  }
}

class PlanEntry<A> implements GateEntry {
  readonly exclusive = false;
  canceled = false;
  constructor(
    private readonly plan: (context: Context.Context<never> | undefined) => A,
    private readonly context: Context.Context<never> | undefined,
    private readonly resume: GraphResume<A>
  ) {}
  run(): void {
    if (this.canceled) return;
    try {
      this.resume(Exit.succeed(this.plan(this.context)));
    } catch (cause) {
      this.resume(Exit.die(cause));
    }
  }
}

/**
 * Where an exclusive entry is: waiting for the gate, running its fiber,
 * canceled before it ran, or finished with the gate released.
 */
type ExclusiveState = "Posted" | "Running" | "Canceled" | "Finished";

class ExclusiveEntry<A> implements GateEntry {
  readonly exclusive = true;
  private state: ExclusiveState = "Posted";
  private fiber: Fiber.Fiber<A> | undefined;
  private interrupted: GraphReply<void> | undefined;

  constructor(
    private readonly gate: GraphGate,
    private readonly effect: Effect.Effect<A>,
    private readonly context: Context.Context<never>,
    private readonly resume: (effect: Effect.Effect<A>) => void
  ) {}

  interrupt(): Effect.Effect<void> {
    if (this.state === "Finished") return Effect.void;
    this.interrupted ??= new GraphReply<void>();
    this.gate.jobs.post({ run: () => this.cancel() });
    return this.interrupted.await;
  }

  // A canceled entry still takes its turn, so its caller resumes in order.
  cancel(): void {
    if (this.state === "Posted") this.state = "Canceled";
    else if (this.state === "Running") this.fiber?.interruptUnsafe();
  }

  run(): void {
    const effect = this.state === "Canceled" ? Effect.interrupt : this.effect;
    this.state = "Running";
    this.fiber = Effect.runForkWith(this.context)(effect);
    this.fiber.addObserver((exit) =>
      this.gate.jobs.post({
        run: () => {
          this.state = "Finished";
          this.gate.finish();
          this.interrupted?.settle(Exit.succeed(undefined));
          this.resume(
            Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)
          );
        },
      })
    );
  }
}

class GateJob implements GraphJob {
  constructor(
    private readonly gate: GraphGate,
    private readonly entry: GateEntry
  ) {}
  run(): void {
    this.gate.accept(this.entry);
  }
}

export function planTask<A>(
  gate: GraphGate,
  plan: (context: Context.Context<never> | undefined) => import("./reply").GraphCellTask<A>,
  context: Context.Context<never> | undefined,
  resume: GraphResume<A>,
  reserve = false
): GraphCancel {
  let cancelTask: GraphCancel | undefined;
  const cancelPlan = gate.planDirect(
    plan,
    context,
    (exit) => {
      if (exit._tag === "Failure") resume(Exit.failCause(exit.cause));
      else cancelTask = exit.value.listen(resume);
    },
    reserve
  );
  return () => (cancelTask === undefined ? cancelPlan() : cancelTask());
}
