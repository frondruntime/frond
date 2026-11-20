import { type Context, Effect, Exit, type Fiber } from "effect";

export type GraphResume<A, E = never> = (exit: Exit.Exit<A, E>) => void;
export type GraphCancel = () => Effect.Effect<void>;
export const noCancel: GraphCancel = () => Effect.void;

export interface GraphCellTask<A> {
  readonly await: Effect.Effect<A>;
  readonly listen: (resume: GraphResume<A>) => GraphCancel;
}

/** Callback replies own no Effect or Promise until a facade requests one. */
export class GraphReply<A, E = never> {
  private result: Exit.Exit<A, E> | undefined;
  private waiters: Set<GraphResume<A, E>> | undefined;

  constructor(
    private readonly onInterrupt?: GraphCancel,
    private readonly onWaiterLeft?: () => void
  ) {}

  /** Callers attached to an unsettled reply. */
  get waiting(): number {
    return this.waiters?.size ?? 0;
  }

  get await(): Effect.Effect<A, E> {
    return Effect.callback((resume) => {
      const cancel = this.listen(resume);
      return Effect.suspend(cancel);
    });
  }

  listen = (resume: GraphResume<A, E>): GraphCancel => {
    if (this.result !== undefined) {
      resume(this.result);
      return noCancel;
    }
    this.waiters ??= new Set();
    this.waiters.add(resume);
    return () => {
      this.waiters?.delete(resume);
      if (this.result !== undefined) return Effect.void;
      this.onWaiterLeft?.();
      return this.onInterrupt?.() ?? Effect.void;
    };
  };

  settle(exit: Exit.Exit<A, E>): void {
    if (this.result !== undefined) return;
    this.result = exit;
    const waiters = this.waiters;
    this.waiters = undefined;
    if (waiters !== undefined) for (const resume of waiters) resume(exit);
  }
}

export function completedTask<A>(value: A): GraphCellTask<A> {
  const reply = new GraphReply<A>();
  reply.settle(Exit.succeed(value));
  return reply;
}

/** Forks `effect` with the facade's services, or with none for a Promise caller. */
export function forkIn<A, E>(
  context: Context.Context<never> | undefined,
  effect: Effect.Effect<A, E>
): Fiber.Fiber<A, E> {
  return context === undefined ? Effect.runFork(effect) : Effect.runForkWith(context)(effect);
}

/** Only the Effect facade captures fiber services; Promise callers pass none. */
export function callbackEffect<A, E = never>(
  start: (context: Context.Context<never>, resume: GraphResume<A, E>) => GraphCancel
): Effect.Effect<A, E> {
  return Effect.withFiber((fiber) =>
    Effect.callback((resume) => {
      const cancel = start(fiber.context, resume);
      return Effect.suspend(cancel);
    })
  );
}

export type CoreCall<F> = F extends (...args: infer Args) => Effect.Effect<infer A, infer E>
  ? (
      ...args: [...Args, context: Context.Context<never> | undefined, resume: GraphResume<A, E>]
    ) => GraphCancel
  : never;
