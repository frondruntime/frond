import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

/**
 * Wire contract between an attached Frond runtime and the hub.
 *
 * Direction of the RPC roles is deliberate and inverted from who dials: the
 * hub listens and is the RPC *server*, the app dials out and is the RPC
 * *client*. That keeps the app free of any listening socket, and it is the only
 * arrangement both `RpcServer.layerHttp` and `RpcClient.layerProtocolSocket`
 * support without a hand-written socket adapter on either side.
 *
 * Hub-to-app work (state reads, and later refresh and action invocation)
 * therefore does not travel as a plain RPC call. It rides the `Attach` response
 * stream as a `Query` command, and the app answers with a separate unary
 * `Reply` correlated by `requestId`. `Attach` is the only long-lived call.
 *
 * Version equality is exact, on both sides, and there is no capability
 * negotiation. That is a deliberate choice rather than an omission: `HubCommand`
 * is a schema union, so an app one version behind would fail to decode a command
 * it has never heard of and drop its socket — presenting as "the runtime stopped
 * emitting", which is the most expensive way this can fail. Refusing the
 * attachment outright says the same thing immediately and in words.
 */
export const HUB_PROTOCOL_VERSION = 3;

/**
 * Unregistered, and chosen for the band rather than the number.
 *
 * Above 9999 to clear the entire dev-server zone — Vite, Metro, Expo, CRA,
 * Django, Storybook, the node inspector — and below 32768 so it can never
 * collide with an ephemeral source port on Linux, whose range starts there.
 *
 * Stable on purpose. Apps hardcode it, so a hub that drifted to the next free
 * port on a collision would leave them dialing nothing, which presents as "the
 * runtime is not emitting" — the most expensive way to fail.
 */
export const HUB_DEFAULT_PORT = 17391;

export const HUB_DEFAULT_HOST = "127.0.0.1";

export const HUB_ATTACH_PATH = "/attach";

/** Where an app dials when it was given no explicit URL. */
export const HUB_DEFAULT_ATTACH_URL = `ws://${HUB_DEFAULT_HOST}:${HUB_DEFAULT_PORT}${HUB_ATTACH_PATH}`;

/**
 * How much of a value crosses the wire.
 *
 * Negotiated in one direction only: the hub asks, and the app answers with the
 * lesser of the request and its own ceiling. The ceiling defaults to `"shape"`,
 * so an app sends structure until someone deliberately decides otherwise — the
 * decision to put real values on a socket should be one somebody made, not one
 * that came with the default.
 */
export const ValuePolicy = Schema.Literals(["none", "shape", "full"]);
export type ValuePolicy = typeof ValuePolicy.Type;

export const RuntimeEventCategory = Schema.Literals([
  "command",
  "diagnostic",
  "input",
  "lifecycle",
  "operation",
  "state",
]);

export const RuntimeEventSeverity = Schema.Literals(["debug", "error", "info", "warning"]);

export const RuntimeEventTimeline = Schema.Literals(["live", "state", "system", "work"]);

export const RuntimeWorkSource = Schema.Literals([
  "react",
  "mobx",
  "node",
  "manual",
  "devtools",
  "runtime",
  "signal",
  "test",
]);

export const RuntimeWorkReason = Schema.Literals([
  "start",
  "stop",
  "readiness",
  "retry",
  "preload",
  "refresh",
  "action",
  "args-update",
  "live",
  "release",
  "eviction",
  "unsafe-update",
  "input",
  "signal",
]);

export const RuntimeWorkPriority = Schema.Literals(["blocking", "visible", "background", "idle"]);

/**
 * Who is attaching.
 *
 * `runtimeId` is the runtime's own `runtime-N` counter and collides freely
 * across tabs, reloads, and processes; `instanceId` is minted once per
 * `attachDevtools` call and is the only field safe to use as an identity key.
 */
export const AttachmentInfo = Schema.Struct({
  protocolVersion: Schema.Number,
  /** Stable for the life of the attaching runtime, including across reconnects. */
  instanceId: Schema.String,
  runtimeId: Schema.String,
  /**
   * How many times this runtime had already attached before this connection.
   *
   * Zero on a first attach; anything higher means the socket dropped and came
   * back, which is the same thing as saying the events in between are gone.
   * Devtools are not durable by design — nothing bridges that gap — so this
   * field exists to make the gap visible rather than to let anyone close it.
   */
  generation: Schema.Number,
  /** Human label for the CLI list, e.g. the host app's package name. */
  name: Schema.String,
  /** Free-form origin hint: "bun", "browser", "expo-ios", … */
  platform: Schema.String,
  startedAt: Schema.Number,
  /** The strongest value policy this app is willing to honor. */
  values: ValuePolicy,
});
export type AttachmentInfo = typeof AttachmentInfo.Type;

/**
 * A runtime event, flattened and already redacted by the sender.
 *
 * `fields` holds JSON-safe shape descriptors, not live values — encoding
 * happens at observe time, because a `RuntimeEventRecord` carries live
 * references that keep mutating after the record is handed out. The descriptor
 * vocabulary is written down once, in `descriptors.ts`, and what each policy
 * produces lives with the walk that produces it — `describeShape` in `shape.ts`,
 * `describeFull` in `full.ts`, `describeError` in `cause.ts`. Nothing on this
 * side should restate any of it and drift.
 */
export const EncodedEventRecord = Schema.Struct({
  sequence: Schema.Number,
  recordedAt: Schema.Number,
  /** The `RuntimeEvent` `_tag`, e.g. "GraphNodeLiveDemandChanged". */
  tag: Schema.String,
  category: RuntimeEventCategory,
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline,
  reportable: Schema.Boolean,
  workId: Schema.Number,
  parentWorkId: Schema.optional(Schema.Number),
  source: RuntimeWorkSource,
  reason: RuntimeWorkReason,
  priority: RuntimeWorkPriority,
  nodeIds: Schema.Array(Schema.String),
  /**
   * Keyed by the event's own field names, minus `_tag`.
   *
   * A record rather than `Unknown`: every consumer — the UI, and shortly the
   * MCP reader — looks fields up by name, and typing the container as unknown
   * only moves that cast to each of them. The *values* stay unknown, which is
   * the honest part: what a field holds depends on the negotiated policy.
   */
  fields: Schema.Record(Schema.String, Schema.Unknown),
  /**
   * What went wrong, as chains of causes rather than as single errors.
   *
   * Each entry is `{_: "error", message, causes}`, outermost cause first. The
   * runtime lifts these off the event's own fields, so the same failure also
   * appears in `fields` — encoded identically, so one failure never reads as
   * two. Present at every policy: `"none"` is a statement about values, and a
   * feed that cannot say what is failing is not worth reading.
   */
  failures: Schema.Array(Schema.Unknown),
});
export type EncodedEventRecord = typeof EncodedEventRecord.Type;

/**
 * One node, as it is right now.
 *
 * Split the same way `EncodedEventRecord` is: the fields a reader filters and
 * branches on are typed, and anything that came out of the app's own data is
 * `Unknown`, because what it holds depends on the negotiated policy. Giving
 * `NodeStatus`, `NodeOperation` and the rest real schemas here would copy core's
 * type surface into the wire contract and guarantee the two drift apart.
 *
 * Every field here has to earn its place in *every row* of a graph read, which
 * is why core's `label` and `key` are not among them: `label` is a formatting of
 * `tag` and `key` is already inside `nodeId`, so both are the same fact charged
 * twice, a few hundred times per snapshot.
 */
export const EncodedNodeSnapshot = Schema.Struct({
  nodeId: Schema.String,
  /** The spec's tag, e.g. `"orders"`. Shared by every key; `nodeId` is the identity. */
  tag: Schema.String,
  /**
   * `"node"`, `"service"`, `"resource"` or `"facade"` — the one identity field
   * nothing else here implies.
   *
   * It says whether this row owns a release: a resource holds something the app
   * has to give back, and a reader deciding what a leak looks like cannot get
   * that from `tag` or `nodeId`.
   *
   * Carried as a string rather than a literal union so a hub can read an app
   * built against a core that has since grown a kind. Version equality already
   * gates the wire; making this field the second thing that can reject a
   * snapshot would buy nothing.
   */
  kind: Schema.String,
  /**
   * Which arm of core's `NodeSnapshot` this is: `Unwired`, `Idle`, `Pending`,
   * `Ready`, `ReadinessError`, `Releasing`, `Invalid`.
   *
   * Typed and hoisted because it is the one field every reader branches on.
   * Left inside the encoded `status` it would oblige an agent to understand this
   * encoder's descriptors before it could ask which nodes are broken.
   */
  state: Schema.String,
  /**
   * Core's per-node write counter, carried verbatim.
   *
   * The cheap way to tell "still the value I saw last time" from "recomputed,
   * and happens to look the same" — which no amount of comparing encoded
   * results can answer once a policy has redacted them.
   */
  revision: Schema.Number,
  status: Schema.Unknown,
  liveDemand: Schema.Unknown,
  operation: Schema.Unknown,
  resultValidity: Schema.optional(Schema.Unknown),
  /**
   * Why this node is not usable, as a chain of causes.
   *
   * Same encoding as `EncodedEventRecord.failures`, deliberately: a node failed
   * in the snapshot and the event that failed it should read identically.
   */
  failure: Schema.optional(Schema.Unknown),
  /**
   * The last operation that failed, as `{operationId, kind, at, error}`.
   *
   * Distinct from `failure`, and the difference is the whole point of keeping
   * it: a node can be `Ready` on a stale-but-valid result while its most recent
   * refresh failed. `failure` would be absent and everything would look fine.
   */
  operationFailure: Schema.optional(Schema.Unknown),
  /** Why live demand could not be served, as `{at, failures}`. */
  liveFailure: Schema.optional(Schema.Unknown),
  /**
   * The node's current value.
   *
   * Only ever present on a single-node query. A graph read of a few hundred
   * nodes is a topology question, and answering it with every result attached
   * would put the whole application state on the wire to draw a diagram.
   */
  result: Schema.optional(Schema.Unknown),
});
export type EncodedNodeSnapshot = typeof EncodedNodeSnapshot.Type;

export const EncodedGraphEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  /** The dependency name the dependent declared, not the target's tag. */
  dependency: Schema.String,
});
export type EncodedGraphEdge = typeof EncodedGraphEdge.Type;

/**
 * The graph at one instant.
 *
 * The counterpart to the event stream rather than a replacement for it: events
 * say what happened, this says what is true. `capturedAt` and `sequence` are
 * what let a reader hold both at once — a snapshot taken "as of sequence 4412"
 * can be lined up against the log the reader already has, instead of being a
 * second account of the same system with no way to relate them.
 */
export const GraphSnapshot = Schema.Struct({
  capturedAt: Schema.Number,
  /**
   * The last event sequence the runtime had recorded when this was taken.
   *
   * Absent on a runtime that has not emitted yet, which is the only honest
   * answer — zero would claim a position in a log that has none.
   */
  sequence: Schema.optional(Schema.Number),
  runtimeId: Schema.String,
  runtimeStatus: Schema.String,
  graphStatus: Schema.String,
  observedInputs: Schema.Number,
  /**
   * The policy the app actually applied, which may be less than was asked for.
   *
   * Stated per snapshot rather than inferred from the attachment: a reader that
   * finds no `result` on a node needs to tell "redacted" from "not ready", and
   * those are the same absence.
   */
  values: ValuePolicy,
  nodes: Schema.Array(EncodedNodeSnapshot),
  edges: Schema.Array(EncodedGraphEdge),
});
export type GraphSnapshot = typeof GraphSnapshot.Type;

/** Every node and edge, with statuses but without results. */
export const GraphQuery = Schema.Struct({ _tag: Schema.tag("Graph") });

/** One node, with its result and the edges incident on it. */
export const NodeQuery = Schema.Struct({
  _tag: Schema.tag("Node"),
  nodeId: Schema.String,
});

export const StateQuery = Schema.Union([GraphQuery, NodeQuery]);
export type StateQuery = typeof StateQuery.Type;

/**
 * The app's answer to one query.
 *
 * `Failed` rather than an RPC error because the reply is a separate call from
 * the request: an error on this channel would fail the *reply*, which is not
 * the thing that went wrong, and would leave the hub waiting out its timeout
 * for an answer that already came back.
 */
export const QueryOutcome = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Snapshot"), snapshot: GraphSnapshot }),
  Schema.Struct({ _tag: Schema.tag("Failed"), reason: Schema.String }),
]);
export type QueryOutcome = typeof QueryOutcome.Type;

/** Hub accepted the attachment and assigned it an id. */
export const HubAttached = Schema.Struct({
  _tag: Schema.tag("Attached"),
  attachmentId: Schema.String,
  /** What the hub is asking for. The app may downgrade, never upgrade. */
  values: ValuePolicy,
});

/** Liveness probe; the app answers by continuing to hold the stream open. */
export const HubPing = Schema.Struct({
  _tag: Schema.tag("Ping"),
  at: Schema.Number,
});

/**
 * Asks the app what is true right now.
 *
 * Rides this stream because the hub has no way to call the app — it listens and
 * the app dials, so the only open channel in this direction is the `Attach`
 * response. The answer comes back as a separate `Reply` call rather than in
 * band, which is why `requestId` exists.
 *
 * `values` is requested per query, not per attachment. A stream of events and a
 * deliberate read of one node are different acts: the first is a firehose worth
 * keeping cheap, the second is someone asking a specific question. Both are
 * still clamped by the app's own ceiling, so this widens nothing the app has not
 * already agreed to.
 */
export const HubQuery = Schema.Struct({
  _tag: Schema.tag("Query"),
  requestId: Schema.String,
  query: StateQuery,
  values: ValuePolicy,
});

/** Server-to-client commands. */
export const HubCommand = Schema.Union([HubAttached, HubPing, HubQuery]);
export type HubCommand = typeof HubCommand.Type;

/**
 * The hub refused the attachment.
 *
 * `reason` is prose for a terminal, not a code to branch on. It is the last
 * thing said on a connection that is about to close, and the symptom on the
 * other end — devtools that quietly never appear — carries no information at
 * all, so the string has to carry the diagnosis and the next step instead. The
 * hub's version mismatch names both versions and which side to upgrade.
 *
 * Specific on purpose, where a rejection elsewhere would be deliberately vague:
 * there is no authentication on this call (see `Attach`), so an uninvited
 * caller learns nothing here it could not learn by dialing and observing, and
 * vagueness would cost only the developer who is actually trying to attach.
 */
export class HubRejection extends Schema.TaggedErrorClass<HubRejection>("HubRejection")(
  "HubRejection",
  { reason: Schema.String }
) {}

/**
 * Opens the attachment and holds it open.
 *
 * The stream's lifetime *is* the attachment's lifetime: when the socket drops,
 * the handler is interrupted, which is how the hub learns about detachment.
 * There is no explicit detach call and there should not be one — a crashed app
 * cannot send it.
 *
 * Unauthenticated on purpose. Browsers do not apply CORS to WebSockets, so any
 * page a developer visits can dial a loopback port — but this direction only
 * carries data *into* the hub, so the worst an uninvited caller achieves is
 * putting junk in a dashboard. The direction where app data leaves is the MCP
 * endpoint, and a secret on this half while that one is open would buy nothing
 * and cost every host app a value to configure.
 *
 * The consequence, stated plainly because something downstream has to honour
 * it: records arriving here are not proof of their own origin, and a consumer
 * that feeds them to an agent is feeding it untrusted text.
 */
export class Attach extends Rpc.make("Frond.Attach", {
  payload: { info: AttachmentInfo },
  success: HubCommand,
  error: HubRejection,
  stream: true,
}) {}

/**
 * Pushes a batch of events.
 *
 * `droppedSince` is the sender's count of records it could not buffer since the
 * previous batch. It is not optional and not a nicety: a devtools feed that
 * silently loses events is worse than one that admits to a gap, because an
 * agent reasoning over the stream cannot tell "did not happen" from "was
 * dropped".
 */
export class Ingest extends Rpc.make("Frond.Ingest", {
  payload: {
    attachmentId: Schema.String,
    records: Schema.Array(EncodedEventRecord),
    droppedSince: Schema.Number,
  },
}) {}

/**
 * Answers one `Query`.
 *
 * A unary call in the app-to-hub direction, correlated by `requestId`, because
 * the RPC roles only run that way — see the note at the top of this file. The
 * consequence worth naming: a reply is not causally tied to the stream that
 * asked for it, so the hub has to time its requests out. An app that dies
 * mid-query simply never calls this.
 */
export class Reply extends Rpc.make("Frond.Reply", {
  payload: {
    attachmentId: Schema.String,
    requestId: Schema.String,
    outcome: QueryOutcome,
  },
}) {}

export const FrondHubRpcs = RpcGroup.make(Attach, Ingest, Reply);
