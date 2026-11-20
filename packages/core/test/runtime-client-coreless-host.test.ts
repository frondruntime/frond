import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import type { NodeId } from "../src/graph";
import {
  FrondRuntimeInvariantViolation,
  type RuntimeCommand,
  type RuntimeEffectBridgeRunner,
  type RuntimeObserver,
  type RuntimeSubmission,
} from "../src/runtime";
import {
  ActionProfileNode,
  createRuntimeClient,
  type MutableProfile,
  unwrapEffect,
} from "./graphTestFixtures";

// A host built outside `createRuntime` has no queue-backed core: the client
// reaches it only through its Effect methods and the caller's runner.

const nodeId = 'resources/action-profile:{"type":"singleton"}' as NodeId;

interface HostProbe {
  /** Calls of `host.submit`, counted when the Effect is built. */
  readonly calls: Array<RuntimeCommand["_tag"]>;
  /** Runs of the submission Effect's body. */
  readonly submitted: Array<RuntimeCommand["_tag"]>;
  readonly runnerCalls: Array<"run" | "runSync">;
  readonly observedNodeIds: Array<NodeId | undefined>;
  interrupted: number;
  completed: number;
}

function corelessHost(
  submit: (command: RuntimeCommand) => Effect.Effect<RuntimeSubmission>,
  run: RuntimeEffectBridgeRunner["run"] = Effect.runPromise
) {
  const probe: HostProbe = {
    calls: [],
    submitted: [],
    runnerCalls: [],
    observedNodeIds: [],
    interrupted: 0,
    completed: 0,
  };
  const host = {
    resolveNodeIdSync: () => nodeId,
    getStatusSync: () => "running" as const,
    readNodeSnapshotSync: () => ({ _tag: "Missing", nodeId }) as const,
    readNodeRevisionSync: () => 0,
    readNodeSnapshot: () => Effect.succeed({ _tag: "Missing", nodeId } as const),
    observe: (_observer: RuntimeObserver, observed?: NodeId) =>
      Effect.sync(() => {
        probe.observedNodeIds.push(observed);
        return { unsubscribe: () => undefined };
      }),
    submit: (command: RuntimeCommand) => {
      probe.calls.push(command._tag);
      return Effect.suspend(() => {
        probe.submitted.push(command._tag);
        return submit(command);
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            probe.completed += 1;
          })
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            probe.interrupted += 1;
          })
        )
      );
    },
  };
  const runner: RuntimeEffectBridgeRunner = {
    run: (effect) => {
      probe.runnerCalls.push("run");
      return run(effect);
    },
    runSync: (effect) => {
      probe.runnerCalls.push("runSync");
      return Effect.runSync(effect);
    },
  };
  const handle = createRuntimeClient(host as never, runner).node<
    Record<string, never>,
    MutableProfile
  >(ActionProfileNode, {});
  return { probe, handle };
}

const readyRead = {
  _tag: "GraphNodeReadyEnsured",
  read: { _tag: "Unwired", nodeId, status: { _tag: "Unwired" } },
} as unknown as RuntimeSubmission;

describe("runtime client over a core-less host", () => {
  test("commands, snapshots, and subscriptions run through the caller's runner", async () => {
    const { probe, handle } = corelessHost(() => Effect.succeed(readyRead));

    await expect(handle.ensureReady()).resolves.toMatchObject({ _tag: "Unwired", nodeId });
    await expect(handle.snapshot()).resolves.toEqual({ _tag: "Missing", nodeId });
    const unsubscribe = handle.subscribe(() => undefined);
    unsubscribe();

    expect(probe.submitted).toEqual(["GraphEnsureReadyNode"]);
    expect(probe.runnerCalls).toEqual(["run", "run", "runSync"]);
    expect(probe.observedNodeIds).toEqual([nodeId]);
  });

  test("an already-aborted signal rejects as the runner does, building but never running the submission", async () => {
    const { probe, handle } = corelessHost(() => Effect.succeed(readyRead));
    const controller = new AbortController();
    controller.abort();

    const rejection = await handle.ensureReady({ ...readiness, signal: controller.signal }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(rejection).toEqual(await runnerInterruption());
    expect(probe.calls).toEqual(["GraphEnsureReadyNode"]);
    expect(probe.submitted).toEqual([]);
  });

  test("aborting a running submission interrupts the host's submit Effect", async () => {
    const { probe, handle } = corelessHost(() => Effect.never);
    const controller = new AbortController();

    const pending = handle.ensureReady({ ...readiness, signal: controller.signal }).then(
      () => false,
      () => true
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(probe.submitted).toEqual(["GraphEnsureReadyNode"]);
    controller.abort();

    expect(await pending).toBe(true);
    expect(probe.interrupted).toBe(1);
  });

  test("an aborted running submission rejects with the runner's own interruption", async () => {
    const { handle } = corelessHost(() => Effect.never);
    const controller = new AbortController();

    const pending = handle.ensureReady({ ...readiness, signal: controller.signal }).then(
      () => undefined,
      (cause: unknown) => cause
    );
    await Promise.resolve();
    controller.abort();

    expect(await pending).toEqual(await runnerInterruption());
  });

  test("an abort after the runner completed keeps the submission's result", async () => {
    const { probe, handle } = corelessHost(() => Effect.succeed(readyRead));
    const controller = new AbortController();

    const pending = handle.ensureReady({ ...readiness, signal: controller.signal });
    expect(probe.completed).toBe(1);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ _tag: "Unwired", nodeId });
  });

  test("a boot attempt settles one microtask after the runner does, resolved or recovered", async () => {
    const resolved = corelessHost(() => Effect.succeed(readyRead)).handle.boot();
    const recovered = corelessHost(() => Effect.die(new Error("submit failed"))).handle.boot();
    if (resolved._tag !== "Pending" || recovered._tag !== "Pending")
      throw new Error("Expected booting reads");
    const [bootResolved, bootRecovered, runnerResolved, runnerRejected] = await Promise.all([
      settleTick(resolved.attempt),
      settleTick(recovered.attempt),
      settleTick(Effect.runPromise(Effect.succeed(readyRead))),
      settleTick(Effect.runPromise(Effect.die(new Error("submit failed")))),
    ]);

    expect([bootResolved, bootRecovered]).toEqual([runnerResolved + 1, runnerRejected + 1]);
  });

  test("a submission tag mismatch fails inside the runner", async () => {
    const { handle } = corelessHost(
      () => Effect.succeed({ _tag: "RuntimeStarted" } as unknown as RuntimeSubmission),
      unwrapEffect
    );

    const rejection = await handle.ensureReady().then(
      () => undefined,
      (cause: unknown) => cause
    );

    if (!Cause.isCause(rejection)) throw new Error("Expected the runner to reject with a Cause");
    expect(Cause.hasDies(rejection)).toBe(true);
    expect(Cause.squash(rejection)).toBeInstanceOf(FrondRuntimeInvariantViolation);
  });

  test("an args update applies to the handle only when its commit succeeds", async () => {
    let succeed = false;
    const { handle } = corelessHost(() =>
      Effect.succeed({
        _tag: "GraphNodeArgsUpdateCompleted",
        result: succeed
          ? { _tag: "Success", nodeId }
          : { _tag: "Failure", nodeId, error: new Error("rejected") },
      } as unknown as RuntimeSubmission)
    );

    await handle.updateArgs({});
    expect(handle.args).toEqual({});
    const rejectedArgs = {} as Record<string, never>;
    await handle.updateArgs(rejectedArgs);
    expect(handle.args).not.toBe(rejectedArgs);
    succeed = true;
    const acceptedArgs = {} as Record<string, never>;
    await handle.updateArgs(acceptedArgs);
    expect(handle.args).toBe(acceptedArgs);
  });
});

/** The number of microtask turns `promise` takes to settle. */
async function settleTick(promise: Promise<unknown>): Promise<number> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  let ticks = 0;
  while (!settled && ticks < 100) {
    ticks += 1;
    await Promise.resolve();
  }
  return ticks;
}

/** What the caller's runner rejects an interrupted Effect with. */
function runnerInterruption(): Promise<unknown> {
  return Effect.runPromise(Effect.interrupt).then(
    () => undefined,
    (cause: unknown) => cause
  );
}

const readiness = { source: "manual", reason: "readiness", priority: "visible" } as const;
