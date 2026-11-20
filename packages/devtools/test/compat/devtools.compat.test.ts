import { afterEach, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import * as FrondTest from "@frondruntime/core/testing";
import * as Devtools from "@frondruntime/devtools";
import { Schema } from "effect";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});
function createHarness() {
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  return harness;
}
type SessionSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly result: { account: string };
}>;
class SessionNode extends Frond.NodeBase<SessionSpec> {
  static readonly spec = Frond.serviceSpec.async<SessionSpec>({
    tag: Frond.tag("compat/devtools/session"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(async () => ({ account: "private account" })),
  });
}
type OrdersSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly deps: { readonly session: Frond.Dep<typeof SessionNode> };
  readonly result: { total: number };
  readonly actions: { readonly fail: Frond.ActionContract<void, void> };
}>;
class OrdersNode extends Frond.NodeBase<OrdersSpec> {
  static readonly spec = Frond.resourceSpec.async<OrdersSpec>({
    tag: Frond.tag("compat/devtools/orders"),
    key: () => Frond.Key.singleton(),
    dependencies: Frond.dependencies(() => ({ session: Frond.dep(SessionNode, {}) })),
    acquire: Frond.Driver.Acquire(async () => ({ total: 42 })),
    actions: {
      fail: Frond.Driver.Action(async () => {
        throw new Error("orders unavailable");
      }),
    },
  });
}

test("Graph snapshots expose serializable topology and typed node metadata without results", async () => {
  const harness = createHarness();
  await harness.startNode(OrdersNode, {});
  const snapshot = Devtools.encodeGraphSnapshot(await harness.runtime.getSnapshot(), {
    policy: "full",
    capturedAt: 123,
  });
  expect(Schema.decodeUnknownSync(Devtools.GraphSnapshot)(snapshot)).toEqual(snapshot);
  expect(snapshot).toMatchObject({
    capturedAt: expect.any(Number),
    runtimeId: expect.any(String),
    runtimeStatus: expect.any(String),
    graphStatus: expect.any(String),
    observedInputs: expect.any(Number),
    values: "full",
    sequence: expect.any(Number),
  });
  expect(snapshot.nodes.map((node) => node.tag).sort()).toEqual([
    "compat/devtools/orders",
    "compat/devtools/session",
  ]);
  for (const node of snapshot.nodes) {
    expect(node).toMatchObject({
      nodeId: expect.any(String),
      tag: expect.any(String),
      kind: expect.any(String),
      state: "Ready",
      revision: expect.any(Number),
      status: expect.any(Object),
      liveDemand: expect.any(Object),
      operation: expect.any(Object),
    });
    expect("result" in node).toBe(false);
    expect("failure" in node).toBe(false);
  }
  expect(snapshot.edges).toEqual([
    { from: expect.any(String), to: expect.any(String), dependency: "session" },
  ]);
  const serialized = JSON.stringify(snapshot);
  expect(JSON.parse(serialized)).toMatchObject({
    nodes: expect.any(Array),
    edges: expect.any(Array),
  });
  expect(serialized).not.toContain("private account");
});

test("Single node snapshots include incident edges and apply the selected value policy", async () => {
  const harness = createHarness();
  const node = await harness.startNode(OrdersNode, {});
  const snapshot = await harness.runtime.getSnapshot();
  for (const [policy, expected] of [
    ["full", { total: 42 }],
    ["shape", "{total}"],
    ["none", "withheld"],
  ] as const) {
    const encoded = Devtools.encodeGraphSnapshot(snapshot, {
      policy,
      capturedAt: 1,
      nodeId: node.nodeId,
    });
    expect(encoded.nodes.map((entry) => entry.nodeId)).toEqual([node.nodeId]);
    expect(encoded.nodes[0]?.result).toEqual(expected);
    expect(encoded.edges).toEqual([
      { from: node.nodeId, to: node.deps.session.nodeId, dependency: "session" },
    ]);
    expect(encoded.values).toBe(policy);
  }
  const dependency = Devtools.encodeGraphSnapshot(snapshot, {
    policy: "full",
    capturedAt: 1,
    nodeId: node.deps.session.nodeId,
  });
  expect(dependency.edges).toEqual([
    { from: node.nodeId, to: node.deps.session.nodeId, dependency: "session" },
  ]);
  expect(
    Devtools.encodeGraphSnapshot(snapshot, { policy: "full", capturedAt: 1, nodeId: "missing" })
      .nodes
  ).toEqual([]);
});

test("Pending and failed snapshots keep their state readable without serializing node facades", async () => {
  const gate = FrondTest.createDeferred<void>();
  const entered = FrondTest.createDeferred<void>();
  class PendingNode extends Frond.NodeBase<SessionSpec> {
    static readonly spec = Frond.serviceSpec.async<SessionSpec>({
      tag: Frond.tag("compat/devtools/pending"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(async () => {
        entered.resolve();
        await gate.promise;
        throw new Error("session unavailable");
      }),
    });
  }
  const harness = createHarness();
  const handle = harness.node(PendingNode, {});
  const readiness = handle.ensureReady();
  await entered.promise;
  const pending = Devtools.encodeGraphSnapshot(await harness.runtime.getSnapshot(), {
    policy: "full",
    capturedAt: 1,
    nodeId: handle.nodeId,
  });
  expect(pending.nodes[0]?.state).toBe("Pending");
  expect("attempt" in (pending.nodes[0] ?? {})).toBe(false);
  gate.resolve();
  await readiness;
  const failed = Devtools.encodeGraphSnapshot(await harness.runtime.getSnapshot(), {
    policy: "shape",
    capturedAt: 1,
    nodeId: handle.nodeId,
  });
  expect(failed.nodes[0]).toMatchObject({
    state: "ReadinessError",
    failure: { _: "error", message: "session unavailable", causes: expect.any(Array) },
  });
  expect("result" in (failed.nodes[0] ?? {})).toBe(false);
});

test("Operation failure snapshots and event records expose the same readable cause chain", async () => {
  const harness = createHarness();
  const node = await harness.startNode(OrdersNode, {});
  await expect(node.actions.fail()).rejects.toMatchObject({ _tag: "ActionFailed" });
  const snapshot = Devtools.encodeGraphSnapshot(await harness.runtime.getSnapshot(), {
    policy: "shape",
    capturedAt: 1,
    nodeId: node.nodeId,
  });
  expect(snapshot.nodes[0]).toMatchObject({
    state: "Ready",
    operationFailure: {
      operationId: expect.any(Number),
      kind: "action",
      at: expect.any(Number),
      error: { _: "error", message: "orders unavailable", causes: expect.any(Array) },
    },
  });
  const record = harness.events.find((entry) => entry.event._tag === "GraphActionFailed");
  if (record === undefined) throw new Error("Missing action failure event");
  const encoded = Devtools.encodeRecord(record, "shape");
  expect(snapshot.nodes[0]?.operationFailure).toMatchObject({ error: encoded.failures[0] });
  expect(Schema.decodeUnknownSync(Devtools.EncodedEventRecord)(encoded)).toMatchObject({
    tag: "GraphActionFailed",
    sequence: expect.any(Number),
    recordedAt: expect.any(Number),
    workId: expect.any(Number),
    nodeIds: [node.nodeId],
    reportable: expect.any(Boolean),
    category: expect.any(String),
    severity: expect.any(String),
    timeline: expect.any(String),
    source: expect.any(String),
    reason: expect.any(String),
    priority: expect.any(String),
  });
  expect(encoded.failures).toContainEqual(
    expect.objectContaining({ _: "error", message: "orders unavailable" })
  );
});

test("Signal event encoding preserves routing identity while withholding payload fields", async () => {
  const harness = createHarness();
  await harness.runtime.publish(
    Frond.Signals.signal({
      channel: "compat/devtools/signals",
      name: "changed",
      payload: { token: "private token" },
    })
  );
  const record = harness.events.find((entry) => entry.event._tag === "RuntimeSignalPublished");
  if (record === undefined) throw new Error("Missing signal publication event");
  const encoded = Devtools.encodeRecord(record, "none");
  expect(encoded).toMatchObject({
    category: "signal",
    channel: "compat/devtools/signals",
    name: "changed",
    fields: {},
    failures: [],
  });
  expect(JSON.stringify(encoded)).not.toContain("private token");
});

test("Value encoders and policy negotiation enforce the application's disclosure ceiling", () => {
  const policies = ["none", "shape", "full"] as const;
  for (const [requestedIndex, requested] of policies.entries()) {
    for (const [ceilingIndex, ceiling] of policies.entries()) {
      const expected = policies[Math.min(requestedIndex, ceilingIndex)];
      if (expected === undefined) throw new Error("Missing disclosure policy");
      expect(Devtools.resolvePolicy(requested, ceiling)).toBe(expected);
    }
  }
  expect(Devtools.createValueEncoder("none").value({ token: "private" })).toBe("withheld");
  expect(Devtools.createValueEncoder("shape").value({ token: "private" })).toBe("{token}");
  expect(Devtools.createValueEncoder("full").value({ total: 42 })).toEqual({ total: 42 });
  expect(
    Devtools.createValueEncoder("none").failure(new Error("service unavailable"))
  ).toMatchObject({ _: "error", message: "service unavailable" });
});

test("Devtools protocol constructors preserve query correlation and rejection reasons", () => {
  expect(typeof Devtools.HUB_PROTOCOL_VERSION).toBe("number");
  expect(Devtools.HUB_DEFAULT_ATTACH_URL).toBe(
    `ws://${Devtools.HUB_DEFAULT_HOST}:${Devtools.HUB_DEFAULT_PORT}${Devtools.HUB_ATTACH_PATH}`
  );
  const query = Schema.decodeUnknownSync(Devtools.HubQuery)({
    _tag: "Query",
    requestId: "query-1",
    query: { _tag: "Node", nodeId: "node-1" },
    values: "shape",
  });
  expect(query).toMatchObject({ requestId: "query-1", query: { _tag: "Node", nodeId: "node-1" } });
  expect(new Devtools.HubRejection({ reason: "version mismatch" })).toMatchObject({
    _tag: "HubRejection",
    reason: "version mismatch",
  });
});
