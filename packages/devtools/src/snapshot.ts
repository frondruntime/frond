import type { Graph, Runtime } from "@frondruntime/core";
import { createValueEncoder, type EncodePolicy, type ValueEncoder } from "./encode.ts";
import type { EncodedGraphEdge, EncodedNodeSnapshot, GraphSnapshot } from "./protocol.ts";

/**
 * Derived from the snapshot rather than imported by name.
 *
 * `NodeOperationFailure` is exported from core and `NodeLiveFailure` is not,
 * even though both appear on the public `NodeSnapshot`. Reading them off the
 * field keeps this file working either way, and means neither can drift from
 * the shape actually being encoded.
 */
type OperationFailure = NonNullable<Graph.NodeSnapshot["operationFailure"]>;
type LiveFailure = NonNullable<Graph.NodeSnapshot["liveFailure"]>;

export type SnapshotRequest = {
  readonly policy: EncodePolicy;
  readonly capturedAt: number;
  /**
   * Narrow to one node and include its result.
   *
   * The whole difference between the two queries. A graph read answers a
   * topology question and a few hundred results would drown it; a node read is
   * someone asking what one value currently is, which is the only question a
   * result answers.
   */
  readonly nodeId?: string | undefined;
};

/**
 * The graph as the app sees it right now, reduced to something sendable.
 *
 * The counterpart to {@link encodeRecord}, and deliberately built from the same
 * {@link ValueEncoder}: a node that is failing in a snapshot and the event that
 * failed it should read identically, and the way to guarantee that is for one
 * piece of code to describe both.
 *
 * Two things in a `NodeSnapshot` cannot cross and are dropped rather than
 * approximated. `Pending.attempt` is a `Promise<NodeRead>` — nothing about it
 * survives serialization, and `state: "Pending"` already says the only thing it
 * would have told a reader. And `Ready.node` is the node facade object, which is
 * mostly methods; `result` is the value someone actually meant to ask about.
 *
 * Two more are dropped for costing a line each in every row of a graph read
 * while saying something the row already said: `label` is core's presentation
 * formatting of `tag`, and `key` is the second half of `nodeId`. `kind` stays —
 * `"node"` against `"resource"` is nowhere in the other fields, and it is what
 * tells a reader whether release semantics apply to this row.
 */
export function encodeGraphSnapshot(
  snapshot: Runtime.RuntimeSnapshot,
  request: SnapshotRequest
): GraphSnapshot {
  const encoder = createValueEncoder(request.policy);

  const nodes =
    request.nodeId === undefined
      ? snapshot.graph.nodes
      : snapshot.graph.nodes.filter((node) => node.nodeId === request.nodeId);

  // Every edge touching the node, in either direction: "what does this depend
  // on" and "what breaks if this does" are the same question asked twice, and a
  // single-node read that answered only the first would be half a diagnosis.
  const edges =
    request.nodeId === undefined
      ? snapshot.graph.edges
      : snapshot.graph.edges.filter(
          (edge) => edge.from === request.nodeId || edge.to === request.nodeId
        );

  return {
    capturedAt: request.capturedAt,
    // Absent rather than zero on a runtime that has not emitted: zero is a real
    // position in a log, and claiming one this snapshot does not have would let
    // a reader line it up against events that had not happened yet. Through
    // `absent` for the same reason everything else optional here is — see below.
    ...absent("sequence", snapshot.events.at(-1)?.sequence, identity),
    runtimeId: snapshot.runtimeId,
    runtimeStatus: snapshot.status,
    graphStatus: snapshot.graph.status,
    observedInputs: snapshot.graph.observedInputs,
    values: request.policy,
    nodes: nodes.map((node) => encodeNode(node, encoder, request.nodeId !== undefined)),
    edges: edges.map(encodeEdge),
  };
}

function encodeEdge(edge: Graph.EdgeSnapshot): EncodedGraphEdge {
  return { from: edge.from, to: edge.to, dependency: edge.dependency };
}

/**
 * One node's worth of failure stays one node's worth.
 *
 * The value encoder guards its own walks, so reaching here should take something
 * it does not model at all. But a graph read is the answer to "what is the app
 * doing", and answering it with a single `Failed` because one row of three
 * hundred could not be encoded trades a complete diagnosis for none. The
 * identity fields are the runtime's own struct rather than app data, so a row
 * that keeps them and drops everything else is still a row a reader can act on —
 * and `status` naming the hole is what stops it reading as a healthy node.
 */
function encodeNode(
  node: Graph.NodeSnapshot,
  encoder: ValueEncoder,
  includeResult: boolean
): EncodedNodeSnapshot {
  try {
    return encodeNodeUnguarded(node, encoder, includeResult);
  } catch {
    return {
      nodeId: node.nodeId,
      tag: node.tag,
      kind: node.kind,
      state: node._tag,
      revision: node.revision,
      status: { _: "opaque", type: "unreadable" },
      liveDemand: { _: "opaque", type: "unreadable" },
      operation: { _: "opaque", type: "unreadable" },
    };
  }
}

function encodeNodeUnguarded(
  node: Graph.NodeSnapshot,
  encoder: ValueEncoder,
  includeResult: boolean
): EncodedNodeSnapshot {
  const failure = nodeFailure(node);

  return {
    nodeId: node.nodeId,
    tag: node.tag,
    kind: node.kind,
    state: node._tag,
    revision: node.revision,
    // `status` can carry an error of its own — `Invalid.error`, or a `Wired` run
    // state that is `Error`. Those reach the value encoder, which routes an
    // `Error` to the same cause-chain description at either policy, so they are
    // not lost the way a hand-rolled struct walk would lose them.
    status: encoder.value(node.status),
    liveDemand: encoder.value(node.liveDemand),
    operation: encoder.value(node.operation),
    ...absent("resultValidity", node.resultValidity, encoder.value),
    ...absent("failure", failure, encoder.failure),
    ...absent("operationFailure", encodeOperationFailure(node.operationFailure, encoder), identity),
    ...absent("liveFailure", encodeLiveFailure(node.liveFailure, encoder), identity),
    // Read off the `Ready` arm rather than from a general field walk, because
    // that is the only arm that has one — an unresolved node has no result, and
    // an absent field here means exactly that.
    ...absent(
      "result",
      includeResult && node._tag === "Ready" ? { value: node.result } : undefined,
      (held) => encoder.value(held.value)
    ),
  };
}

const identity = <A>(value: A): A => value;

/**
 * Omits the key rather than setting it to `undefined`.
 *
 * Load-bearing, not tidiness. These fields cross as `Schema.optional`, and an
 * explicit `undefined` in that position does not survive the trip — it arrives
 * as `null`, so a healthy node would report `failure: null` and a topology read
 * would report a `result` on every node it deliberately withheld one from. An
 * absent key is the only encoding that still reads as "there is nothing here".
 *
 * The `result` case goes through a wrapper because `undefined` is a legitimate
 * value for a `Ready` node to hold, and unwrapping it here would make "the node
 * resolved to undefined" indistinguishable from "no result was asked for".
 */
function absent<K extends string, A, B>(
  key: K,
  value: A | undefined,
  encode: (value: A) => B
): { [P in K]?: B } {
  return value === undefined ? {} : ({ [key]: encode(value) } as { [P in K]?: B });
}

/**
 * The failure that explains this node's state, if it has one.
 *
 * The arm-specific error wins over the general `failure` field: on a node that
 * is `ReadinessError` or `Invalid`, that error *is* why the node is in that arm,
 * whereas `failure` is whatever was last recorded and can be older.
 */
function nodeFailure(node: Graph.NodeSnapshot): unknown {
  if (node._tag === "ReadinessError" || node._tag === "Invalid") {
    return node.error;
  }

  return node.failure;
}

/**
 * Unwrapped rather than handed to the value encoder whole.
 *
 * `NodeOperationFailure` is a struct with an error inside it, and passing the
 * struct as a value would reduce the whole thing to `{operationId,kind,at,error}`
 * at `"shape"` — a key list, with the error behind the last key never described
 * at all. That is the exact loss the failure path exists to prevent. Naming the
 * field explicitly is what keeps the chain crossing at every policy.
 */
function encodeOperationFailure(
  failure: OperationFailure | undefined,
  encoder: ValueEncoder
): unknown | undefined {
  return failure === undefined
    ? undefined
    : {
        operationId: failure.operationId,
        kind: failure.kind,
        at: failure.at,
        error: encoder.failure(failure.error),
      };
}

/** Same reasoning as {@link encodeOperationFailure}, over a list. */
function encodeLiveFailure(
  failure: LiveFailure | undefined,
  encoder: ValueEncoder
): unknown | undefined {
  return failure === undefined
    ? undefined
    : { at: failure.at, failures: failure.failures.map(encoder.failure) };
}
