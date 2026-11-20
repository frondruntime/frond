import { Effect } from "effect";
import type { NodeId } from "../graph/types/ids";
import type { RuntimeClientHost, RuntimeEffectBridgeRunner } from "./client";
import { type RuntimeCore, runtimeCore } from "./core";
import { FrondRuntimeInvariantViolation } from "./errors";
import { corePromise, promiseRejection } from "./promiseFacade";
import type { RuntimeCommand, RuntimeNodeSnapshotLookup, RuntimeSubmission } from "./types";

/** The callback surface a runtime client and its handles submit and read through. */
export interface RuntimeClientCore {
  /**
   * Submits `command` and resolves with `project` of its submission, or with
   * `recover` of a rejection. The command's `metadata.signal` aborts the call.
   * `onSubmitted` sees the submission before `project`; on a host with a core
   * it sees it even after the caller aborted, since the commit still happened.
   */
  readonly submitPromise: {
    (command: RuntimeCommand): Promise<RuntimeSubmission>;
    <A>(
      command: RuntimeCommand,
      project: (submission: RuntimeSubmission) => A,
      recover?: (cause: unknown) => A,
      onSubmitted?: (submission: RuntimeSubmission) => void
    ): Promise<A>;
  };
  readonly observeSync: RuntimeCore["observeSync"];
  readonly readNodeSnapshot: (nodeId: NodeId) => Promise<RuntimeNodeSnapshotLookup<unknown>>;
  /**
   * Submits an `__unsafe` command without a caller to answer, and hands a
   * rejection to the host's diagnostics hook instead of dropping it.
   */
  readonly scheduleUnsafe: (command: RuntimeCommand) => void;
}

/**
 * The optional diagnostics hook a core-less host may carry for `__unsafe`: a
 * plain callback, or the host service's form that returns an Effect to run.
 */
type UnsafeFailureRecorder = {
  readonly recordUnsafeScheduleFailure?:
    | ((command: RuntimeCommand, cause: unknown) => Effect.Effect<void> | void)
    | undefined;
};

/**
 * The client core for `host`, built once per client.
 *
 * A host from `makeRuntimeHost` carries its queue-backed core, which the client
 * calls directly. Any other host reaches the runtime only through its Effect
 * methods, so each call runs its whole pipeline (submission, abort race, and
 * projection) as one Effect in the caller's runner, and the runner decides
 * what the caller sees.
 */
export function coreOf(
  host: RuntimeClientHost,
  runner: RuntimeEffectBridgeRunner
): RuntimeClientCore {
  const core = runtimeCore(host);
  if (core !== undefined)
    return {
      submitPromise: <A>(
        command: RuntimeCommand,
        project?: (submission: RuntimeSubmission) => A,
        recover?: (cause: unknown) => A,
        onSubmitted?: (submission: RuntimeSubmission) => void
      ) =>
        corePromise<RuntimeSubmission, unknown, A>(
          (resume) =>
            core.submit(
              command,
              undefined,
              onSubmitted === undefined
                ? resume
                : (exit) => {
                    if (exit._tag === "Success") onSubmitted(exit.value);
                    resume(exit);
                  }
            ),
          project,
          command.metadata?.signal,
          recover
        ),
      observeSync: core.observeSync,
      readNodeSnapshot: (nodeId) => Promise.resolve(host.readNodeSnapshotSync(nodeId)),
      // The failure is recorded inside the submission's own resume, with the
      // value a Promise caller would reject with, so a submission the stop
      // interrupts records before the stop sweeps observer work, and the sweep
      // owns the diagnostic sink it starts.
      scheduleUnsafe: (command) => {
        const record = (cause: unknown): void => {
          core.recordUnsafeScheduleFailure(command, cause, undefined, ignoreExit);
        };
        try {
          core.submit(command, undefined, (exit) => {
            if (exit._tag === "Failure") record(promiseRejection(exit.cause));
          });
        } catch (cause) {
          record(cause);
        }
      },
    };
  return {
    submitPromise: <A>(
      command: RuntimeCommand,
      project?: (submission: RuntimeSubmission) => A,
      recover?: (cause: unknown) => A,
      onSubmitted?: (submission: RuntimeSubmission) => void
    ) => {
      const submitted = host.submit(command);
      const projected =
        project === undefined
          ? (submitted as Effect.Effect<A, unknown>)
          : submitted.pipe(
              Effect.map((submission) => {
                onSubmitted?.(submission);
                return project(submission);
              })
            );
      const signal = command.metadata?.signal;
      const running = runner.run(
        signal === undefined ? projected : interruptOnSignal(projected, signal)
      );
      return recover === undefined ? running : running.catch(recover);
    },
    observeSync: (observer, nodeId) => runner.runSync(host.observe(observer, nodeId)),
    readNodeSnapshot: (nodeId) => runner.run(host.readNodeSnapshot(nodeId)),
    scheduleUnsafe: (command) => {
      void runner.run(host.submit(command)).catch((cause) => {
        const recorded = (host as UnsafeFailureRecorder).recordUnsafeScheduleFailure?.(
          command,
          cause
        );
        // A failing diagnostics hook is dropped, as the core path drops its exit.
        if (Effect.isEffect(recorded)) void runner.run(recorded).catch(ignoreExit);
      });
    },
  };
}

/** Drops a diagnostics hook's outcome. */
function ignoreExit(): void {}

/**
 * `submission` narrowed to the `expected` tag its command defines.
 *
 * A mismatch is a runtime invariant violation, not a user-facing graph failure,
 * so it throws rather than returning a typed `RuntimeError`.
 */
export function expectSubmission<TTag extends RuntimeSubmission["_tag"]>(
  submission: RuntimeSubmission,
  expected: TTag
): Extract<RuntimeSubmission, { readonly _tag: TTag }> {
  if (submission._tag !== expected)
    throw new FrondRuntimeInvariantViolation({
      message: `Expected runtime submission ${expected}, received ${submissionTag(submission)}.`,
      cause: submission,
    });
  return submission as Extract<RuntimeSubmission, { readonly _tag: TTag }>;
}

function submissionTag(value: unknown): string {
  if (typeof value === "object" && value !== null && "_tag" in value) {
    return String(value._tag);
  }

  return "unknown";
}

const signalAborted = Symbol("frond.runtime/action-signal-aborted");

/**
 * Ties `signal` to Effect interruption for a caller-cancellable submission.
 *
 * An already-aborted signal settles as interruption without submitting at all.
 * Otherwise the submission races an abort waiter: when the signal fires,
 * `raceFirst` interrupts the losing submission fiber and awaits that
 * interruption before resuming, so the abort takes exactly the
 * caller-fiber-interruption path the graph already pins — the cell queue claims
 * the reply and interrupts the worker (`cellQueue.ts` awaiter propagation), a
 * queued worker never invokes the driver, an active single-owner operation
 * aborts its `ctx.signal` (`driverOperationRunner.ts` `startEdge` cancel), and a joined
 * operation keeps running for its other awaiters. The overall effect then
 * settles as interruption, which `unwrapEffect` rejects with the interrupted
 * `Cause`.
 */
export function interruptOnSignal<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    if (signal.aborted) {
      return Effect.interrupt;
    }

    return Effect.raceFirst(effect, awaitAbort(signal)).pipe(
      Effect.flatMap((value) =>
        value === signalAborted ? Effect.interrupt : Effect.succeed(value as A)
      )
    );
  });
}

function awaitAbort(signal: AbortSignal): Effect.Effect<typeof signalAborted> {
  return Effect.callback<typeof signalAborted>((resume) => {
    const onAbort = () => resume(Effect.succeed(signalAborted));
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}
