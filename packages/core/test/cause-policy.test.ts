import { expect, test } from "bun:test";
import { Cause } from "effect";
// The cause policy has no public entry; pin its contract directly.
import { reportCause, singleFailure } from "../src/graph/driverExecution/causePolicy";
import type { GraphJob } from "../src/graph/queue/jobQueue";

test("singleFailure returns the error of a single Fail", () => {
  const failure = { _tag: "Rejected" };
  expect(singleFailure(Cause.fail(failure))).toBe(failure);
});

test("singleFailure squashes any other cause as Cause.squash does", () => {
  const failure = { _tag: "Rejected" };
  const defect = new Error("defect");
  const causes = [
    Cause.die(defect),
    Cause.interrupt(),
    Cause.combine(Cause.die(defect), Cause.fail(failure)),
    Cause.combine(Cause.interrupt(), Cause.fail(failure)),
    Cause.combine(Cause.interrupt(), Cause.die(defect)),
  ];
  // An interrupt-only cause squashes to a fresh Error each time, so compare by value.
  for (const cause of causes) expect(singleFailure(cause)).toEqual(Cause.squash(cause));
  expect(singleFailure(causes[2] as Cause.Cause<unknown>)).toBe(failure);
});

test("reportCause posts a job that throws the cause", () => {
  const posted: GraphJob[] = [];
  const cause = Cause.die(new Error("lost"));
  reportCause(
    {
      observerFibers: new Set(),
      post: (job) => posted.push(job),
      hasPendingJobs: () => posted.length > 0,
    },
    cause
  );
  expect(posted).toHaveLength(1);
  let thrown: unknown;
  try {
    posted[0]?.run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(cause);
});
