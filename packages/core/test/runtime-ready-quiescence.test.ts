import { describe, expect, test } from "bun:test";
import { FrondNodeNotReady } from "../src/runtime";
import { createDeferredDriver, createFrondTestHarness } from "../src/testing";
import {
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
  TransportNode,
  unwrapEffect,
} from "./graphTestFixtures";

const testWork = {
  source: "test",
  reason: "readiness",
  priority: "blocking",
} as const;

type GatedSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

function gatedNode(tag: string) {
  const deferred = createDeferredDriver<string>();

  class GatedNode extends NodeBase<GatedSpec> {
    static readonly spec = serviceSpec.fromDriver<GatedSpec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      driver: deferred.driver,
    });
  }

  return { deferred, GatedNode };
}

describe("handle.readReady / handle.ensureReadyNode", () => {
  test("Ready projects the typed node instance", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(TransportNode, {});
    await handle.ensureReady(testWork);

    const node = handle.readReady();

    // Type pin: readReady returns the handle's typed node instance, not object.
    node satisfies TransportNode;
    expect(node).toBeInstanceOf(TransportNode);
    expect(node).toBe(harness.readReady(handle).node);

    await harness.teardown();
  });

  test("Error rethrows the read's underlying error", async () => {
    const { deferred, GatedNode } = gatedNode("testing/resources/read-ready-error");
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(GatedNode, {});
    const readiness = handle.ensureReady(testWork);

    await deferred.acquire.waitForCall();
    const boom = new Error("acquire exploded");
    deferred.acquire.rejectNext(boom);
    await readiness;

    let thrown: unknown;

    try {
      handle.readReady();
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBe(harness.readError(handle).error);
    expect(thrown).not.toBeInstanceOf(FrondNodeNotReady);

    await harness.teardown();
  });

  test("Unwired throws FrondNodeNotReady with readiness unwired", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(TransportNode, {});

    let thrown: unknown;

    try {
      handle.readReady();
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(FrondNodeNotReady);
    const notReady = thrown as FrondNodeNotReady;
    expect(notReady._tag).toBe("FrondNodeNotReady");
    expect(notReady.name).toBe("FrondNodeNotReady");
    expect(notReady.readiness).toBe("unwired");
    expect(notReady.nodeId).toBe(handle.nodeId);
    // Never materialized: no snapshot, so no tag is reachable.
    expect(notReady.tag).toBeUndefined();

    await harness.teardown();
  });

  test("Pending throws FrondNodeNotReady with readiness pending and the node tag", async () => {
    const { deferred, GatedNode } = gatedNode("testing/resources/read-ready-pending");
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(GatedNode, {});
    const readiness = handle.ensureReady(testWork);
    await deferred.acquire.waitForCall();

    let thrown: unknown;

    try {
      handle.readReady();
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(FrondNodeNotReady);
    const notReady = thrown as FrondNodeNotReady;
    expect(notReady.readiness).toBe("pending");
    expect(notReady.nodeId).toBe(handle.nodeId);
    expect(notReady.tag).toBe("testing/resources/read-ready-pending");

    deferred.acquire.resolveNext("ready");
    await readiness;
    expect(handle.readReady()).toBeInstanceOf(GatedNode);

    await harness.teardown();
  });

  test("Idle after release throws FrondNodeNotReady with readiness idle", async () => {
    const { deferred, GatedNode } = gatedNode("testing/resources/read-ready-idle");
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(GatedNode, {});
    const readiness = handle.ensureReady(testWork);
    await deferred.acquire.waitForCall();
    deferred.acquire.resolveNext("ready");
    await readiness;
    await handle.releaseResources("test release", testWork);

    let thrown: unknown;

    try {
      handle.readReady();
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(FrondNodeNotReady);
    const notReady = thrown as FrondNodeNotReady;
    expect(notReady.readiness).toBe("idle");
    expect(notReady.tag).toBe("testing/resources/read-ready-idle");

    await harness.teardown();
  });

  test("ensureReadyNode awaits one readiness attempt and projects the node", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(TransportNode, {});
    const node = await handle.ensureReadyNode(testWork);

    node satisfies TransportNode;
    expect(node).toBeInstanceOf(TransportNode);
    expect(node).toBe(handle.readReady());

    await harness.teardown();
  });

  test("ensureReadyNode rejects with the underlying readiness error", async () => {
    const { deferred, GatedNode } = gatedNode("testing/resources/ensure-ready-node-error");
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(GatedNode, {});
    const attempt = handle.ensureReadyNode(testWork);

    await deferred.acquire.waitForCall();
    deferred.acquire.rejectNext(new Error("acquire exploded"));

    let thrown: unknown;

    try {
      await attempt;
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBe(harness.readError(handle).error);
    expect(thrown).not.toBeInstanceOf(FrondNodeNotReady);

    await harness.teardown();
  });
});

describe("runtime.pendingOperations / runtime.isQuiescent", () => {
  test("an idle runtime is quiescent", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(TransportNode, {});
    await handle.ensureReady(testWork);

    expect(harness.runtime.pendingOperations()).toEqual([]);
    expect(harness.runtime.isQuiescent()).toBe(true);

    await harness.teardown();
  });

  test("a gated in-flight action appears with nodeId/tag and disappears after settle", async () => {
    const deferred = createDeferredDriver<string>({ actions: ["ping"] });

    class QuiescenceActionNode extends NodeBase<GatedSpec> {
      static readonly spec = serviceSpec.fromDriver<GatedSpec>({
        tag: "testing/resources/quiescence-action",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: deferred.driver,
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(QuiescenceActionNode, {});
    const readiness = handle.ensureReady(testWork);
    await deferred.acquire.waitForCall();
    deferred.acquire.resolveNext("ready");
    await readiness;

    expect(harness.runtime.isQuiescent()).toBe(true);

    const action = unwrapEffect(
      handle.action("ping", undefined, { source: "test", reason: "action", priority: "visible" })
    );
    await deferred.actions.ping.waitForCall();

    const pending = harness.runtime.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.nodeId).toBe(handle.nodeId);
    expect(pending[0]?.tag).toBe("testing/resources/quiescence-action");
    expect(pending[0]?.operation._tag).toBe("Running");
    expect(pending[0]?.operation.kind).toBe("action");
    expect(pending[0]?.operation.action).toBe("ping");
    expect(harness.runtime.isQuiescent()).toBe(false);

    deferred.actions.ping.resolveNext("pong");
    await expect(action).resolves.toMatchObject({ _tag: "Success", value: "pong" });

    expect(harness.runtime.pendingOperations()).toEqual([]);
    expect(harness.runtime.isQuiescent()).toBe(true);

    await harness.teardown();
  });

  test("matches getSnapshotSync availability before start and after stop", async () => {
    const harness = createFrondTestHarness();

    // Pin: getSnapshotSync answers on a not-yet-started runtime, so the
    // quiescence projection does too (empty graph reads as quiescent).
    expect(harness.runtime.getSnapshotSync().graph.nodes).toEqual([]);
    expect(harness.runtime.pendingOperations()).toEqual([]);
    expect(harness.runtime.isQuiescent()).toBe(true);

    await harness.start();
    const handle = harness.node(TransportNode, {});
    await handle.ensureReady(testWork);
    await harness.stop();

    // Pin: getSnapshotSync also answers on a stopped runtime; the projection
    // stays consistent with whatever the stopped graph snapshot reports.
    expect(harness.runtime.getSnapshotSync().status).toBe("stopped");
    expect(harness.runtime.pendingOperations()).toEqual([]);
    expect(harness.runtime.isQuiescent()).toBe(true);

    await harness.teardown();
  });
});
