import { describe, expect, test } from "bun:test";
import { Context, Effect, Exit } from "effect";
import { GraphCellQueue } from "../src/graph/cell/cellQueue";
import { runEffectEdge } from "../src/graph/driverExecution/effectRunner";
import { makeGraphJobQueue } from "../src/graph/queue/jobQueue";
import type { GraphCellTask, GraphResume } from "../src/graph/queue/reply";
import { registerAdmittedTask } from "../src/graph/system/admissionRegistration";

describe("admission registration", () => {
  test("registers before execution and clears before a waiter's follow-up", async () => {
    const active = new Map<string, GraphCellTask<number>>();
    const queue = new GraphCellQueue(makeGraphJobQueue());
    let runs = 0;
    const submit = () =>
      registerAdmittedTask({
        active,
        key: "same",
        start: (onComplete) =>
          queue.submitSync(
            {
              start: (context, resume) =>
                runEffectEdge(
                  Effect.sync(() => {
                    expect(active.has("same")).toBe(true);
                    return ++runs;
                  }),
                  context,
                  resume
                ),
            },
            Context.empty(),
            { onComplete }
          ),
      });
    const first = submit();
    expect(active.get("same")).toBe(first);
    expect(runs).toBe(0);
    await Effect.runPromise(
      first.await.pipe(
        Effect.flatMap((value) => {
          expect(value).toBe(1);
          expect(active.has("same")).toBe(false);
          return submit().await;
        })
      )
    );
    expect(runs).toBe(2);
    expect(active.size).toBe(0);
  });

  test("a decided operation with no attached caller releases admission before it settles", async () => {
    const active = new Map<string, GraphCellTask<number>>();
    const queue = new GraphCellQueue(makeGraphJobQueue());
    const resumes: Array<GraphResume<number>> = [];
    const submit = () =>
      registerAdmittedTask({
        active,
        key: "same",
        start: (onComplete) =>
          queue.submitSync(
            {
              start: (_context, resume) => {
                resumes.push(resume);
                return () => Effect.void;
              },
            },
            Context.empty(),
            { onComplete, onDecided: onComplete }
          ),
      });
    const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    const first = submit();
    const detachFirst = first.listen(() => undefined);
    await drain();
    expect(resumes).toHaveLength(1);
    Effect.runSync(detachFirst());
    expect(active.get("same")).toBe(first);
    resumes[0]?.(Exit.succeed(1));
    expect(active.has("same")).toBe(false);

    // The successor registers before the abandoned operation's settlement
    // drains; that settlement must not clear the successor's admission.
    const second = submit();
    const detachLastSecond = second.listen(() => undefined);
    await drain();
    expect(active.get("same")).toBe(second);
    expect(resumes).toHaveLength(2);

    // While any caller stays attached, a decided operation holds admission;
    // the last caller to detach after the decision releases it.
    const detachSecond = second.listen(() => undefined);
    resumes[1]?.(Exit.succeed(2));
    expect(active.get("same")).toBe(second);
    Effect.runSync(detachSecond());
    expect(active.get("same")).toBe(second);
    Effect.runSync(detachLastSecond());
    expect(active.has("same")).toBe(false);
    await drain();
    expect(active.size).toBe(0);
  });
});
