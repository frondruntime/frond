import {
  EncodedEventRecord,
  GraphSnapshot,
  type StateQuery,
  ValuePolicy,
} from "@frondruntime/devtools";
import { Effect, Layer, Schema } from "effect";
import { type McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import type { AttachmentsNode, AttachmentView } from "./nodes/attachments.ts";
import type { EventRing } from "./retention.ts";

export const MCP_PATH = "/mcp";

/**
 * Ceiling on records returned by one read.
 *
 * The limiting resource is the caller's context window, not the hub's memory:
 * with `"full"` values a single graph event can run to kilobytes, so a
 * thousand-record answer is not a large response, it is an unusable one. The
 * reader pages with `since` instead, which is also how it stays correct while
 * the app keeps running.
 */
const MAX_LIMIT = 200;

const DEFAULT_LIMIT = 50;

/**
 * What a state read asks for when the caller does not say.
 *
 * The same `"full"` the hub asks the event stream for, and for the same reason:
 * a reader that can only see the shape of a value cannot answer the question it
 * was asked. It is a request, not a grant — the app clamps it against its own
 * ceiling, and the snapshot reports which policy actually applied.
 */
const DEFAULT_VALUES: typeof ValuePolicy.Type = "full";

/**
 * Reported by every read, alongside the records.
 *
 * Two independent gap counters, because they mean different things and an agent
 * that conflates them will draw the wrong conclusion. `droppedBySender` is
 * events the attached app could not buffer — they never reached the hub.
 * `evictedByHub` is events the hub received and has since aged out. Only the
 * second can be avoided by reading sooner.
 */
const Coverage = Schema.Struct({
  /** Sequence of the oldest record still held, absent when nothing is held. */
  oldestRetainedSequence: Schema.optional(Schema.Number),
  newestSequence: Schema.optional(Schema.Number),
  retainedCount: Schema.Number,
  evictedByHub: Schema.Number,
  droppedBySender: Schema.Number,
});

const RuntimeSummary = Schema.Struct({
  attachmentId: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  /**
   * A label, not an identity. It comes from a per-process counter, so unrelated
   * processes all report `runtime-1`; never match runtimes on it.
   */
  runtimeId: Schema.String,
  /** Distinguishes the hub's own self-attachment from the apps it observes. */
  isHub: Schema.Boolean,
  /**
   * Reconnections before this one. Above zero means the socket dropped and the
   * app came back, and that everything it emitted in between is simply gone —
   * `connectedAt` is when the current connection began, not when the app
   * started. Nothing bridges that gap; devtools history is not durable.
   */
  generation: Schema.Number,
  connectedAt: Schema.Number,
  eventCount: Schema.Number,
  lastSequence: Schema.Number,
  lastEventAt: Schema.Number,
  lastTag: Schema.optional(Schema.String),
  /** What the app agreed to send. `"shape"` means values are descriptors. */
  values: Schema.String,
  coverage: Coverage,
});

const EventPage = Schema.Struct({
  attachmentId: Schema.String,
  records: Schema.Array(EncodedEventRecord),
  /**
   * Pass back as `since` to continue. Absent when the page is empty, which is
   * the signal to keep the previous cursor rather than reset it.
   */
  nextSince: Schema.optional(Schema.Number),
  /** True when the filter had more matches than `limit` allowed. */
  hasMore: Schema.Boolean,
  coverage: Coverage,
});

/**
 * Returned as a result rather than raised — see `failureMode: "return"`.
 *
 * The tradeoff is deliberate and it is not free. Raising sets MCP's `isError`
 * flag, which is the more accurate signal; it also renders the failure as
 * `Cause.pretty`, which means every "you passed an id that does not exist"
 * arrives with a six-frame stack through Effect and the frond driver attached.
 * That noise lands in the caller's context window, and none of it is about the
 * caller's mistake. Returning keeps the answer to a tagged message the model
 * can act on, and `_tag` says plainly that it is a failure.
 *
 * The ambiguous-attachment case is why the message is worth protecting: it
 * carries the full candidate list, which turns "you must pass an id" into
 * something answerable without a second round trip.
 */
export class McpReadError extends Schema.ErrorClass<McpReadError>("McpReadError")({
  _tag: Schema.tag("McpReadError"),
  message: Schema.String,
}) {}

/**
 * Marks a tool as a pure read.
 *
 * Not decoration: MCP clients decide whether a call needs a human in the loop
 * from these hints, and Effect's defaults are the cautious ones — unannotated
 * tools advertise themselves as destructive. Every tool here only reads a
 * buffer the hub already holds, and saying otherwise would train the user to
 * approve prompts that mean nothing.
 */
function readOnly<T extends Tool.Any>(tool: T): T {
  return (
    tool
      .annotate(Tool.Readonly, true)
      .annotate(Tool.Destructive, false)
      .annotate(Tool.Idempotent, true)
      // The world here is the set of runtimes attached to this hub, which is
      // closed and enumerable — `frond_list_runtimes` is the enumeration.
      .annotate(Tool.OpenWorld, false) as T
  );
}

const ListRuntimes = readOnly(
  // No `parameters`: the default is `Tool.EmptyParams`, which renders as a
  // closed empty object. An explicit `Schema.Struct({})` does not — it emits an
  // `anyOf` of object-or-array that tells a caller nothing.
  Tool.make("frond_list_runtimes", {
    description:
      "List the Frond runtimes currently attached to this hub, with how much event history the hub holds for each. Call this first: every other tool takes an attachmentId from here.",
    success: Schema.Struct({ runtimes: Schema.Array(RuntimeSummary) }),
  })
);

const ReadEvents = readOnly(
  Tool.make("frond_read_events", {
    description:
      "Read runtime events from an attached Frond runtime, oldest first. Page forward by passing the returned nextSince back as since. Every filter is an exact match and they combine with AND. A record's failures array holds what went wrong as a chain of causes, outermost first; read its message field before its frames, because the outermost cause is usually a wrapper with nothing in it.",
    parameters: Schema.Struct({
      attachmentId: Schema.optionalKey(Schema.String),
      /** Exclusive. Omit to start from the oldest record the hub still holds. */
      since: Schema.optionalKey(Schema.Int),
      limit: Schema.optionalKey(Schema.Int),
      /** e.g. "GraphNodeChanged", "GraphActionFailed". */
      tag: Schema.optionalKey(Schema.String),
      category: Schema.optionalKey(Schema.String),
      severity: Schema.optionalKey(Schema.String),
      /** Format is `tag:key`, e.g. `hub/attachments:v1:"singleton"`. */
      nodeId: Schema.optionalKey(Schema.String),
    }),
    success: EventPage,
    failure: McpReadError,
    failureMode: "return",
  })
);

const ReadWork = readOnly(
  Tool.make("frond_read_work", {
    description:
      "Read every event belonging to one unit of runtime work, oldest first. A workId groups a whole acquire/refresh/action cascade, so this is the tool for 'what actually happened when that failed'.",
    parameters: Schema.Struct({
      workId: Schema.Int,
      attachmentId: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int),
    }),
    success: EventPage,
    failure: McpReadError,
    failureMode: "return",
  })
);

const ReadState = readOnly(
  Tool.make("frond_read_state", {
    description:
      "Read the current state of an attached Frond runtime's graph: every node with its status, plus the dependency edges between them. This is the graph as it is right now, not history — use frond_read_events for how it got here, and line the two up with the returned capturedAt (wall clock) and sequence (the last event the runtime had emitted when the snapshot was taken). Omit nodeId for the whole graph, which comes back without node results because a few hundred values would bury the topology; pass a nodeId to get that one node with its result and the edges on either side of it. Results only appear if the app's own ceiling allows them — the values field says which policy was actually applied, and 'shape' means every value is a descriptor rather than data.",
    parameters: Schema.Struct({
      attachmentId: Schema.optionalKey(Schema.String),
      /** Format is `tag:key`, e.g. `hub/attachments:v1:"singleton"`. */
      nodeId: Schema.optionalKey(Schema.String),
      /**
       * How much of each value to send. Advisory: the app clamps this against
       * its own ceiling, so asking for `"full"` from an app that publishes
       * `"shape"` returns shapes rather than an error.
       */
      values: Schema.optionalKey(ValuePolicy),
    }),
    success: GraphSnapshot,
    failure: McpReadError,
    failureMode: "return",
  })
);

const HubTools = Toolkit.make(ListRuntimes, ReadEvents, ReadWork, ReadState);

/**
 * Exposes the hub's retained history over MCP.
 *
 * Closes over the attachments *node* rather than a snapshot, for the same
 * reason the RPC handlers do: reads must see the map as it is when the tool is
 * called, not as it was when the layer was built.
 *
 * No auth on this path, matching the attach socket. A deliberate, scoped
 * decision: the hub binds loopback, and 0.3.0 is a local devtools daemon aimed
 * at development data.
 *
 * It does mean this endpoint hands an agent text the hub did not author. A
 * reader that treats a record's `tag` or `fields` as instructions rather than
 * as data is trusting whatever managed to open a socket, which — since attach
 * is unauthenticated too — is anything running on, or rendered by, this
 * machine.
 */
export function mcpLayer(options: {
  readonly attachments: AttachmentsNode;
  readonly selfInstanceId: string;
  readonly version: string;
}): Layer.Layer<McpServer.McpServer | McpSchema.McpServerClient, never, HttpRouter.HttpRouter> {
  const { attachments, selfInstanceId, version } = options;

  const handlers = HubTools.toLayer({
    frond_list_runtimes: () =>
      Effect.sync(() => ({
        runtimes: rows(attachments).map(([view, ring]) => ({
          attachmentId: view.attachmentId,
          name: view.info.name,
          platform: view.info.platform,
          runtimeId: view.info.runtimeId,
          // `instanceId`, not `runtimeId`: the latter is a per-process counter,
          // so every process's first runtime is `runtime-1` and this comparison
          // would match every row.
          isHub: view.info.instanceId === selfInstanceId,
          generation: view.info.generation,
          connectedAt: view.connectedAt,
          eventCount: view.eventCount,
          lastSequence: view.lastSequence,
          lastEventAt: view.lastEventAt,
          ...(view.lastTag === undefined ? {} : { lastTag: view.lastTag }),
          values: view.info.values,
          coverage: coverageOf(view, ring),
        })),
      })),

    frond_read_events: (params) =>
      Effect.map(resolve(attachments, selfInstanceId, params.attachmentId), ([view, ring]) =>
        page(view, ring, {
          since: params.since,
          limit: clampLimit(params.limit),
          tag: params.tag,
          category: params.category,
          severity: params.severity,
          nodeId: params.nodeId,
        })
      ),

    frond_read_work: (params) =>
      Effect.map(resolve(attachments, selfInstanceId, params.attachmentId), ([view, ring]) =>
        page(view, ring, { limit: clampLimit(params.limit), workId: params.workId })
      ),

    frond_read_state: (params) =>
      Effect.flatMap(resolve(attachments, selfInstanceId, params.attachmentId), ([view]) => {
        const query: StateQuery =
          params.nodeId === undefined ? { _tag: "Graph" } : { _tag: "Node", nodeId: params.nodeId };

        return attachments.result.queries
          .ask(view.attachmentId, query, params.values ?? DEFAULT_VALUES)
          .pipe(
            // The two failures are folded into one shape here because MCP has
            // one error channel, but they are kept apart in the message: a
            // `QueryUnanswered` is the connection, a `Failed` outcome is the
            // runtime. An agent that cannot tell them apart will retry the
            // wrong one.
            Effect.mapError((error) => new McpReadError({ message: error.reason })),
            Effect.flatMap((outcome) =>
              outcome._tag === "Failed"
                ? Effect.fail(
                    new McpReadError({
                      message: `${view.attachmentId} could not build the snapshot: ${outcome.reason}`,
                    })
                  )
                : Effect.succeed(outcome.snapshot)
            ),
            // A node query that matched nothing comes back as a well-formed
            // snapshot with no nodes in it, which reads as "the graph is empty"
            // rather than "that id is wrong". Saying so costs one branch and
            // saves a round trip spent staring at an empty array.
            Effect.flatMap((snapshot) =>
              params.nodeId !== undefined && snapshot.nodes.length === 0
                ? Effect.fail(
                    new McpReadError({
                      message: `No node ${params.nodeId} in ${view.attachmentId}. Call frond_read_state without nodeId to list the graph.`,
                    })
                  )
                : Effect.succeed(snapshot)
            )
          );
      }),
  });

  return Layer.merge(
    McpServer.layerHttp({ name: "frond-hub", version, path: MCP_PATH }),
    McpServer.toolkit(HubTools).pipe(Layer.provide(handlers))
  );
}

type Row = readonly [AttachmentView, EventRing | undefined];

function rows(attachments: AttachmentsNode): ReadonlyArray<Row> {
  const { attachments: views, retained } = attachments.result;

  return [...views.values()].map((view) => [view, retained.get(view.attachmentId)] as const);
}

/**
 * Picks the attachment to read from.
 *
 * A sole attached *app* is used without being named, because making the common
 * case cost a round trip is how a tool ends up unused. The hub attaches to its
 * own runtime, so it is always in the list and would be that sole candidate on
 * an otherwise idle machine — and answering "what does my graph look like" with
 * the devtools' own graph is a wrong answer wearing the shape of a right one.
 * It is excluded from the fallback rather than from `candidates`: naming it
 * explicitly still resolves, because inspecting the hub is a real thing to want
 * and only the *accidental* case is the bug.
 *
 * Everything else fails with the candidates listed, on the same reasoning as
 * the ambiguity below — a guess the caller cannot see is worse than a question
 * it can answer in one more call.
 */
function resolve(
  attachments: AttachmentsNode,
  selfInstanceId: string,
  attachmentId: string | undefined
): Effect.Effect<Row, McpReadError> {
  const candidates = rows(attachments);

  if (attachmentId !== undefined) {
    const found = candidates.find(([view]) => view.attachmentId === attachmentId);

    return found === undefined
      ? Effect.fail(
          new McpReadError({
            message: `No attachment ${attachmentId}. ${describe(candidates, selfInstanceId)}`,
          })
        )
      : Effect.succeed(found);
  }

  // `instanceId`, not `runtimeId`, for the reason `frond_list_runtimes` gives:
  // the latter is a per-process counter and would match every row.
  const apps = candidates.filter(([view]) => view.info.instanceId !== selfInstanceId);
  const only = apps[0];

  if (apps.length === 1 && only !== undefined) {
    return Effect.succeed(only);
  }

  return Effect.fail(new McpReadError({ message: noDefault(candidates, apps, selfInstanceId) }));
}

/**
 * What to say when no attachment can be picked for the caller.
 *
 * Each branch ends in an action rather than a diagnosis, because the caller is
 * a model deciding what to do next: "no app is attached" invites a retry of the
 * same call, "attach one, or name the hub" does not.
 */
function noDefault(
  candidates: ReadonlyArray<Row>,
  apps: ReadonlyArray<Row>,
  selfInstanceId: string
): string {
  if (apps.length > 1) {
    return `attachmentId is required when more than one app is attached. ${describe(apps, selfInstanceId)}`;
  }

  const hub = candidates.find(([view]) => view.info.instanceId === selfInstanceId);

  if (hub === undefined) {
    return "No runtimes are attached to this hub. Attach an app with attachDevtools({ runtime, name }) from @frondruntime/devtools, then call frond_list_runtimes.";
  }

  return `No app is attached to this hub; the only attachment is the hub's own runtime. Attach an app with attachDevtools({ runtime, name }) from @frondruntime/devtools and call frond_list_runtimes again, or pass attachmentId ${hub[0].attachmentId} to read the hub itself.`;
}

function describe(candidates: ReadonlyArray<Row>, selfInstanceId: string): string {
  if (candidates.length === 0) {
    return "No runtimes are attached.";
  }

  // The hub is marked rather than dropped: a caller choosing from this list has
  // to be able to tell the program it is debugging from the tool it is
  // debugging with, and the two rows are otherwise indistinguishable.
  return `Attached: ${candidates
    .map(
      ([view]) =>
        `${view.attachmentId} (${view.info.name}, ${view.info.platform}${
          view.info.instanceId === selfInstanceId ? ", this hub" : ""
        })`
    )
    .join("; ")}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }

  // Silently clamping beats failing: an over-large limit is a caller guessing
  // at the ceiling, and `hasMore` already tells it the answer was cut short.
  return Math.max(1, Math.min(Math.trunc(limit), MAX_LIMIT));
}

function page(
  view: AttachmentView,
  ring: EventRing | undefined,
  options: Parameters<EventRing["read"]>[0]
): typeof EventPage.Type {
  if (ring === undefined) {
    // The view exists but its ring does not, which means the attachment landed
    // between the two writes. Reported as an empty page rather than an error:
    // there is genuinely nothing retained yet.
    return {
      attachmentId: view.attachmentId,
      records: [],
      hasMore: false,
      coverage: coverageOf(view, undefined),
    };
  }

  const window = ring.read(options);
  const last = window.records[window.records.length - 1];

  return {
    attachmentId: view.attachmentId,
    records: window.records,
    ...(last === undefined ? {} : { nextSince: last.sequence }),
    hasMore: window.hasMore,
    coverage: coverageOf(view, ring),
  };
}

function coverageOf(view: AttachmentView, ring: EventRing | undefined): typeof Coverage.Type {
  const oldest = ring?.oldestRetainedSequence;
  const newest = ring?.newestSequence;

  return {
    ...(oldest === undefined ? {} : { oldestRetainedSequence: oldest }),
    ...(newest === undefined ? {} : { newestSequence: newest }),
    retainedCount: ring?.size ?? 0,
    evictedByHub: ring?.evictedCount ?? 0,
    droppedBySender: view.droppedCount,
  };
}
