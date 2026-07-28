import { describe, expect, test } from "bun:test";
import type { Graph, Runtime } from "@frondruntime/core";
import type { EncodePolicy } from "../src/encode.ts";
import { encodeGraphSnapshot } from "../src/snapshot.ts";

/**
 * Builds a node in whichever arm the test needs.
 *
 * Cast for the same reason `encode.test.ts` casts its events: `NodeSnapshot` is
 * a closed union the graph owns, and constructing a genuine `Ready` node means
 * standing up a runtime and a spec. What is under test is the encoder, which
 * reads the arm off `_tag` and the rest off named fields.
 */
function node(overrides: Record<string, unknown>): Graph.NodeSnapshot {
  return {
    _tag: "Idle",
    nodeId: "orders:v1",
    tag: "orders",
    kind: "resource",
    label: "orders",
    key: "singleton",
    revision: 1,
    status: { _tag: "Unwired" },
    resultValidity: undefined,
    liveDemand: { _tag: "None" },
    liveFailure: undefined,
    operation: { _tag: "None" },
    operationFailure: undefined,
    failure: undefined,
    ...overrides,
  } as unknown as Graph.NodeSnapshot;
}

function snapshotOf(options: {
  readonly nodes: ReadonlyArray<Graph.NodeSnapshot>;
  readonly edges?: ReadonlyArray<Graph.EdgeSnapshot>;
  readonly events?: ReadonlyArray<{ readonly sequence: number }>;
}): Runtime.RuntimeSnapshot {
  return {
    runtimeId: "runtime-1",
    status: "running",
    inputIngestionEnabled: true,
    events: options.events ?? [],
    sinks: [],
    signals: [],
    signalSubscribers: [],
    graph: {
      status: "running",
      observedInputs: 3,
      nodes: options.nodes,
      edges: options.edges ?? [],
    },
  } as unknown as Runtime.RuntimeSnapshot;
}

function encode(
  snapshot: Runtime.RuntimeSnapshot,
  policy: EncodePolicy,
  nodeId?: string
): ReturnType<typeof encodeGraphSnapshot> {
  return encodeGraphSnapshot(snapshot, { policy, capturedAt: 1_700, nodeId });
}

const edge = (from: string, to: string, dependency: string): Graph.EdgeSnapshot =>
  ({ from, to, dependency }) as unknown as Graph.EdgeSnapshot;

describe("encodeGraphSnapshot", () => {
  test("a graph read carries every node and edge", () => {
    const encoded = encode(
      snapshotOf({
        nodes: [node({}), node({ nodeId: "session:v1", tag: "session" })],
        edges: [edge("orders:v1", "session:v1", "session")],
      }),
      "full"
    );

    expect(encoded.nodes.map((row) => row.nodeId)).toEqual(["orders:v1", "session:v1"]);
    expect(encoded.edges).toEqual([{ from: "orders:v1", to: "session:v1", dependency: "session" }]);
    expect(encoded.runtimeStatus).toBe("running");
    expect(encoded.graphStatus).toBe("running");
    expect(encoded.observedInputs).toBe(3);
    expect(encoded.capturedAt).toBe(1_700);
  });

  /**
   * The whole reason the two queries are separate. A topology read of a few
   * hundred nodes that carried every result would put the application's state on
   * the wire to draw a diagram.
   */
  test("a graph read carries no results, even at full", () => {
    const encoded = encode(
      snapshotOf({ nodes: [node({ _tag: "Ready", result: { token: "secret" } })] }),
      "full"
    );

    expect(encoded.nodes[0]?.result).toBeUndefined();
  });

  test("a node read narrows to that node and includes its result", () => {
    const encoded = encode(
      snapshotOf({
        nodes: [
          node({ _tag: "Ready", result: { total: 42 } }),
          node({ nodeId: "session:v1", tag: "session" }),
        ],
      }),
      "full",
      "orders:v1"
    );

    expect(encoded.nodes).toHaveLength(1);
    expect(encoded.nodes[0]?.state).toBe("Ready");
    expect(encoded.nodes[0]?.result).toEqual({ total: 42 });
  });

  /**
   * Both directions, because "what does this depend on" and "what breaks if this
   * does" are the same question asked twice.
   */
  test("a node read carries the edges on either side of it", () => {
    const encoded = encode(
      snapshotOf({
        nodes: [node({})],
        edges: [
          edge("orders:v1", "session:v1", "session"),
          edge("cart:v1", "orders:v1", "orders"),
          edge("cart:v1", "session:v1", "session"),
        ],
      }),
      "full",
      "orders:v1"
    );

    expect(encoded.edges).toEqual([
      { from: "orders:v1", to: "session:v1", dependency: "session" },
      { from: "cart:v1", to: "orders:v1", dependency: "orders" },
    ]);
  });

  test("a result is redacted to its shape when the policy says shape", () => {
    const encoded = encode(
      snapshotOf({ nodes: [node({ _tag: "Ready", result: { token: "secret" } })] }),
      "shape",
      "orders:v1"
    );

    expect(encoded.values).toBe("shape");
    expect(encoded.nodes[0]?.result).toBe("{token}");
  });

  /**
   * `"none"` used to fall through to the shape encoder, so an app that had said
   * it would disclose nothing still answered with a key list per node. The
   * assertion that matters is the second one: not that the marker is right, but
   * that no key name reached the wire.
   */
  test("a none snapshot describes no value at all", () => {
    const encoded = encode(
      snapshotOf({ nodes: [node({ _tag: "Ready", result: { token: "secret" } })] }),
      "none",
      "orders:v1"
    );

    expect(encoded.nodes[0]?.result).toBe("withheld");
    expect(encoded.nodes[0]?.status).toBe("withheld");
    expect(JSON.stringify(encoded)).not.toContain("token");
  });

  /**
   * Both are the same fact charged twice in every row of a graph read: `label`
   * is core's formatting of `tag`, and `key` is the half of `nodeId` after the
   * colon. `kind` stays — release semantics are not derivable from either.
   */
  test("a node row carries no label and no key", () => {
    const row = encode(snapshotOf({ nodes: [node({})] }), "full").nodes[0];

    expect(row).not.toHaveProperty("label");
    expect(row).not.toHaveProperty("key");
    expect(row?.kind).toBe("resource");
  });

  /**
   * `Pending.attempt` is a live `Promise` and `Ready.node` is the node facade —
   * neither survives serialization, and neither is what anyone meant to ask for.
   */
  test("the pending promise and the node facade never reach the wire", () => {
    const encoded = encode(
      snapshotOf({
        nodes: [
          node({ _tag: "Pending", attempt: Promise.resolve("never awaited") }),
          node({
            _tag: "Ready",
            nodeId: "session:v1",
            result: 1,
            node: { refresh: () => undefined },
          }),
        ],
      }),
      "full"
    );

    expect(JSON.stringify(encoded)).not.toContain("attempt");
    expect(JSON.stringify(encoded)).not.toContain("refresh");
    expect(encoded.nodes[0]?.state).toBe("Pending");
  });

  /**
   * The bug this whole encoder split exists to prevent. An `Error` handed to the
   * value encoder at `"shape"` comes out as `{}` — an empty key list, because
   * `message` and `stack` are not own-enumerable — so a failing node would
   * report that it failed and say nothing about why.
   */
  test("an operation failure crosses as a cause chain even at shape", () => {
    const encoded = encode(
      snapshotOf({
        nodes: [
          node({
            operationFailure: {
              operationId: "op-9",
              kind: "refresh",
              at: 1_650,
              error: new Error("the upstream is down"),
            },
          }),
        ],
      }),
      "shape"
    );

    const failure = encoded.nodes[0]?.operationFailure as {
      readonly operationId: string;
      readonly kind: string;
      readonly at: number;
      readonly error: { readonly _: string; readonly message: string };
    };

    expect(failure.operationId).toBe("op-9");
    expect(failure.kind).toBe("refresh");
    expect(failure.at).toBe(1_650);
    expect(failure.error._).toBe("error");
    expect(failure.error.message).toBe("the upstream is down");
  });

  test("live failures cross as a list of cause chains", () => {
    const encoded = encode(
      snapshotOf({
        nodes: [
          node({
            liveFailure: { at: 1_660, failures: [new Error("subscription closed")] },
          }),
        ],
      }),
      "shape"
    );

    const failure = encoded.nodes[0]?.liveFailure as {
      readonly at: number;
      readonly failures: ReadonlyArray<{ readonly _: string; readonly message: string }>;
    };

    expect(failure.at).toBe(1_660);
    expect(failure.failures[0]?._).toBe("error");
    expect(failure.failures[0]?.message).toBe("subscription closed");
  });

  /**
   * The arm's own error is why the node is in that arm; `failure` is whatever
   * was recorded last and can be older.
   */
  test("an invalid node reports the error that invalidated it", () => {
    const encoded = encode(
      snapshotOf({
        nodes: [
          node({
            _tag: "Invalid",
            error: new Error("the key no longer resolves"),
            failure: new Error("something older"),
          }),
        ],
      }),
      "shape"
    );

    const failure = encoded.nodes[0]?.failure as { readonly message: string };

    expect(encoded.nodes[0]?.state).toBe("Invalid");
    expect(failure.message).toBe("the key no longer resolves");
  });

  /**
   * Zero is a real position in a log. Claiming one this snapshot does not have
   * would let a reader line it up against events that had not happened yet.
   */
  test("a runtime that has emitted nothing reports no sequence at all", () => {
    expect(encode(snapshotOf({ nodes: [] }), "full").sequence).toBeUndefined();
  });

  test("the sequence is the last event the runtime had emitted", () => {
    const encoded = encode(
      snapshotOf({ nodes: [], events: [{ sequence: 41 }, { sequence: 42 }] }),
      "full"
    );

    expect(encoded.sequence).toBe(42);
  });
});
