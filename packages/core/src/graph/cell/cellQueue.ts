import { type Context, Effect, Exit } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import { runEffectEdge } from "../driverExecution/effectRunner";
import type { GraphJob, GraphJobQueue } from "../queue/jobQueue";
import {
  forkIn,
  type GraphCancel,
  type GraphCellTask,
  GraphReply,
  type GraphResume,
} from "../queue/reply";

export type { GraphCellTask } from "../queue/reply";

export interface GraphCellOperation<A> {
  readonly start: (
    context: Context.Context<never> | undefined,
    resume: GraphResume<A>,
    decided: () => void
  ) => GraphCancel;
  /** Settles the operation once it is canceled; a plain interrupt when absent. */
  readonly interrupt?:
    | ((reason?: RuntimeCancellationReason | undefined) => Effect.Effect<A>)
    | undefined;
  /**
   * Interrupts the started work alongside `interrupt` instead of after it, as
   * an Effect worker is: an interrupt that waits on an observer never holds
   * the work's finalizers back.
   */
  readonly interruptsWorkAlongside?: true | undefined;
}

export interface GraphCellSubmitOptions {
  readonly onComplete?: (() => void) | undefined;
  /**
   * Runs at most once, before the settle job drains, when the operation's
   * outcome is known (its driver edge ended or it resumed) and no caller is
   * attached: at that moment, or when the last attached caller detaches later.
   */
  readonly onDecided?: (() => void) | undefined;
  readonly interruptible?: boolean | undefined;
}

interface CellEntry extends GraphJob {
  readonly cleanup: boolean;
  start(): void;
  cancel(reason?: RuntimeCancellationReason): void;
}

export class GraphCellQueue {
  private active: CellEntry | undefined;
  private accepted = 0;
  get isIdle(): boolean {
    return this.accepted === 0;
  }
  /** Whether an operation was accepted after the one the cell is running. */
  get hasQueued(): boolean {
    return this.accepted > 1;
  }
  private readonly pending: CellEntry[] = [];
  private readonly closing: GraphReply<void>[] = [];

  constructor(
    readonly jobs: GraphJobQueue,
    private closed?: RuntimeCancellationReason
  ) {}

  submitSync<A>(
    operation: GraphCellOperation<A>,
    context: Context.Context<never> | undefined,
    options?: GraphCellSubmitOptions,
    cleanup = false
  ): GraphCellTask<A> {
    this.accepted += 1;
    const entry = new OperationEntry(this, operation, context, options, cleanup);
    this.jobs.post(entry);
    return entry.reply;
  }

  accept(entry: CellEntry): void {
    if (this.closed !== undefined && !entry.cleanup) entry.cancel(this.closed);
    else {
      this.pending.push(entry);
      this.advance();
    }
  }

  private advance(): void {
    if (this.active !== undefined) return;
    this.active = this.pending.shift();
    if (this.active !== undefined) this.active.start();
    else for (const reply of this.closing.splice(0)) reply.settle(Exit.succeed(undefined));
  }

  finished(entry: CellEntry): void {
    this.accepted -= 1;
    if (this.active === entry) this.active = undefined;
    else {
      const index = this.pending.indexOf(entry);
      if (index !== -1) this.pending.splice(index, 1);
    }
    this.advance();
  }

  close(
    reason: RuntimeCancellationReason = { _tag: "Released", detail: "graph cell is closed" }
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const reply = new GraphReply<void>();
      // The close job runs after every already-posted submission.
      this.jobs.post({
        run: () => {
          this.closed ??= reason;
          this.closing.push(reply);
          this.active?.cancel(this.closed);
          for (const entry of this.pending) entry.cancel(this.closed);
          this.advance();
        },
      });
      return reply.await;
    });
  }

  /**
   * Closes the cell, then runs `cleanup` as the cell's last operation. An
   * interrupted caller interrupts the cleanup and waits for its finalizers.
   */
  shutdown<A>(options?: {
    readonly reason?: RuntimeCancellationReason | undefined;
    readonly cleanup?: Effect.Effect<A> | undefined;
  }): Effect.Effect<A | undefined> {
    const cleanup = options?.cleanup;
    const closed = this.close(options?.reason);
    if (cleanup === undefined) return closed.pipe(Effect.as(undefined));
    return closed.pipe(
      Effect.andThen(
        Effect.withFiber(
          (fiber) =>
            this.submitSync<A>(
              {
                start: (context, resume) => runEffectEdge(cleanup, context, resume),
                interruptsWorkAlongside: true,
              },
              fiber.context,
              { interruptible: true },
              true
            ).await
        )
      )
    );
  }
}

/** Where an entry's work is. Each step moves forward only. */
type OperationPhase = "Pending" | "Running" | "Interrupting" | "Done";

/**
 * Whether the entry has run `onDecided`: `Decided` once its outcome is known,
 * `Released` once `onDecided` ran with no caller attached.
 */
type OperationRelease = "Undecided" | "Decided" | "Released";

class OperationEntry<A> implements CellEntry {
  readonly reply: GraphReply<A>;
  private phase: OperationPhase = "Pending";
  private release: OperationRelease = "Undecided";
  private cancelWork: GraphCancel | undefined;
  private canceledAwaiter: GraphReply<void> | undefined;

  constructor(
    private readonly owner: GraphCellQueue,
    private readonly operation: GraphCellOperation<A>,
    private readonly context: Context.Context<never> | undefined,
    private readonly options: GraphCellSubmitOptions | undefined,
    readonly cleanup: boolean
  ) {
    this.reply = new GraphReply(
      options?.interruptible === true ? this.interruptAwaiter : undefined,
      this.releaseIfUnattended
    );
  }

  private readonly interruptAwaiter = (): Effect.Effect<void> => {
    if (this.phase === "Done") return Effect.void;
    this.canceledAwaiter ??= new GraphReply<void>();
    this.owner.jobs.post({
      run: () => this.cancel({ _tag: "Interrupted", detail: "operation awaiter interrupted" }),
    });
    return this.canceledAwaiter.await;
  };

  run(): void {
    this.owner.accept(this);
  }

  private readonly decide = (): void => {
    if (this.release === "Undecided") this.release = "Decided";
    this.releaseIfUnattended();
  };

  // Early release needs both: an outcome no new caller may join, and no
  // attached caller whose concurrent joiners would otherwise start fresh.
  private readonly releaseIfUnattended = (): void => {
    if (this.release !== "Decided" || this.reply.waiting > 0) return;
    this.release = "Released";
    try {
      this.options?.onDecided?.();
    } catch {
      /* Cleanup must not strand replies. */
    }
  };

  private readonly resumeWork = (exit: Exit.Exit<A>): void => {
    this.decide();
    this.owner.jobs.post(new SettleEntry(this, exit, false));
  };

  private readonly resumeInterrupt = (exit: Exit.Exit<A>): void => {
    this.owner.jobs.post(new SettleEntry(this, exit, true));
  };

  start(): void {
    if (this.phase !== "Pending") return;
    this.phase = "Running";
    try {
      this.cancelWork = this.operation.start(this.context, this.resumeWork, this.decide);
    } catch (cause) {
      this.resumeWork(Exit.die(cause));
    }
  }

  // An interrupt's exit wins: its cleanup has already awaited the canceled
  // work. A worker exit counts only while the entry is still running.
  settle(exit: Exit.Exit<A>, interrupted: boolean): void {
    if (interrupted || this.phase === "Running") this.complete(exit);
  }

  cancel(reason?: RuntimeCancellationReason): void {
    if (this.phase === "Interrupting" || this.phase === "Done") return;
    this.phase = "Interrupting";
    if (this.operation.interruptsWorkAlongside === true) {
      this.interruptAlongsideWork(reason);
      return;
    }
    const work = Effect.suspend(() => {
      const cleanup = this.cancelWork?.() ?? Effect.void;
      return this.interruptOperation(reason).pipe(Effect.ensuring(cleanup));
    });
    forkIn(this.context, work).addObserver(this.resumeInterrupt);
  }

  // The cancel aborts the work at once; the interrupt starts next, then the
  // work's interruption. The interrupt's exit settles the entry once both end.
  private interruptAlongsideWork(reason: RuntimeCancellationReason | undefined): void {
    let stopWork: Effect.Effect<void> = Effect.void;
    let interrupt: Effect.Effect<A>;
    try {
      stopWork = this.cancelWork?.() ?? Effect.void;
      interrupt = this.interruptOperation(reason);
    } catch (cause) {
      interrupt = Effect.die(cause);
    }
    const interrupting = forkIn(this.context, interrupt);
    const stopping = forkIn(this.context, stopWork);
    interrupting.addObserver((exit) => stopping.addObserver(() => this.resumeInterrupt(exit)));
  }

  private interruptOperation(reason: RuntimeCancellationReason | undefined): Effect.Effect<A> {
    const interrupt = this.operation.interrupt;
    return interrupt === undefined ? Effect.interrupt : interrupt(reason);
  }

  private complete(exit: Exit.Exit<A>): void {
    if (this.phase === "Done") return;
    this.phase = "Done";
    // Admission is cleared before any waiter can submit a follow-up operation.
    try {
      this.options?.onComplete?.();
    } catch {
      /* Cleanup must not strand replies. */
    }
    this.reply.settle(exit);
    this.owner.finished(this);
    this.canceledAwaiter?.settle(Exit.succeed(undefined));
  }
}

class SettleEntry<A> implements GraphJob {
  constructor(
    private readonly entry: OperationEntry<A>,
    private readonly exit: Exit.Exit<A>,
    private readonly interrupted: boolean
  ) {}
  run(): void {
    this.entry.settle(this.exit, this.interrupted);
  }
}
