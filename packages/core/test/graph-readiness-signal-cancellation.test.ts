import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Driver, Key, NodeBase, type NodeSpec, serviceSpec, tag } from "../src";
import { createFrondTestHarness } from "../src/testing";

// Caller cancellation for readiness calls: `metadata.signal` on `ensureReady`,
// `ensureReadyNode`, and `boot` stops the caller waiting. The shared readiness
// attempt is owned by the graph, not by any single awaiter.

function makeGate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

async function outcome(
  promise: Promise<unknown>
): Promise<{ ok: true } | { ok: false; cause: unknown }> {
  try {
    await promise;
    return { ok: true };
  } catch (cause) {
    return { ok: false, cause };
  }
}

// The Promise surface runs through the runtime bridge (`Effect.runPromise`), so
// interruption rejects as that bridge's interruption Error, not a bare Cause.
function isInterruption(cause: unknown): boolean {
  return cause instanceof Error && /interrupted/i.test(cause.message);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

type SlowSpec = NodeSpec<{
  readonly mode: "effect";
  readonly key: Key.Singleton;
  readonly result: { readonly ready: true };
}>;

function makeSlowNode(name: string) {
  const gate = makeGate();
  const probe = { acquires: 0, acquireAborted: false };

  class SlowNode extends NodeBase<SlowSpec> {
    static readonly spec = serviceSpec.effect<SlowSpec>({
      tag: tag(name),
      key: () => Key.singleton(),
      acquire: Driver.Acquire((ctx) =>
        Effect.gen(function* () {
          probe.acquires += 1;
          ctx.signal.addEventListener("abort", () => {
            probe.acquireAborted = true;
          });
          yield* Effect.promise(() => gate.opened);
          return { ready: true as const };
        })
      ),
    });
  }

  return { SlowNode, gate, probe };
}

describe("readiness caller cancellation via metadata.signal", () => {
  test("an already-aborted signal settles as interruption without starting acquire", async () => {
    const { SlowNode, probe } = makeSlowNode("signal-ready/pre-aborted");
    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(SlowNode, {});
    const controller = new AbortController();
    controller.abort();

    const result = await outcome(handle.ensureReady({ signal: controller.signal }));

    expect(result.ok).toBe(false);
    expect(probe.acquires).toBe(0);
    await harness.teardown();
  });

  test("aborting ensureReady mid-acquire rejects the caller as interruption", async () => {
    const { SlowNode, gate, probe } = makeSlowNode("signal-ready/ensure-ready");
    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(SlowNode, {});
    const controller = new AbortController();

    const pending = outcome(handle.ensureReady({ signal: controller.signal }));
    await tick();
    expect(probe.acquires).toBe(1);

    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.ok === false && isInterruption(result.cause)).toBe(true);

    // The handle recovers: a later call completes readiness.
    gate.release();
    const read = await handle.ensureReady();
    expect(read._tag).toBe("Ready");
    // Sole-awaiter abort did not cancel the graph-owned attempt: the later
    // call joined it instead of starting a second acquire.
    expect(probe.acquires).toBe(1);
    expect(probe.acquireAborted).toBe(false);
    await harness.teardown();
  });

  test("aborting ensureReadyNode mid-acquire rejects the caller as interruption", async () => {
    const { SlowNode, gate } = makeSlowNode("signal-ready/ensure-ready-node");
    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(SlowNode, {});
    const controller = new AbortController();

    const pending = outcome(handle.ensureReadyNode({ signal: controller.signal }));
    await tick();
    controller.abort();
    const result = await pending;
    expect(result.ok === false && isInterruption(result.cause)).toBe(true);

    gate.release();
    const node = await handle.ensureReadyNode();
    expect(node).toBeInstanceOf(SlowNode);
    await harness.teardown();
  });

  test("aborting a joined awaiter leaves the other awaiter's readiness attempt running", async () => {
    const { SlowNode, gate, probe } = makeSlowNode("signal-ready/joined");
    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(SlowNode, {});
    const controller = new AbortController();

    const survivor = handle.ensureReady();
    await tick();
    const cancelled = outcome(handle.ensureReady({ signal: controller.signal }));
    await tick();

    controller.abort();
    const result = await cancelled;
    expect(result.ok === false && isInterruption(result.cause)).toBe(true);
    expect(probe.acquireAborted).toBe(false);

    gate.release();
    await expect(survivor).resolves.toMatchObject({ _tag: "Ready" });
    expect(probe.acquires).toBe(1);
    await harness.teardown();
  });

  test("boot with an aborted signal does not hang and does not wedge the node", async () => {
    const { SlowNode, gate } = makeSlowNode("signal-ready/boot");
    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(SlowNode, {});
    const controller = new AbortController();

    const read = handle.boot({ signal: controller.signal });
    expect(read._tag).toBe("Pending");
    await tick();
    controller.abort();
    await tick();

    gate.release();
    const ready = await handle.ensureReady();
    expect(ready._tag).toBe("Ready");
    await harness.teardown();
  });
});
