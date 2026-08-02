import { GraphSnapshot, type StateQuery, ValuePolicy } from "@frondruntime/devtools";
import { Effect, Layer, Schema } from "effect";
import { type McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import {
  clampLimit,
  EventPage,
  eventReadOptions,
  McpReadError,
  page,
  RuntimeSummary,
  resolve,
  rows,
  summarize,
} from "./mcpReads.ts";
import type { AttachmentsNode } from "./nodes/attachments.ts";

export const MCP_PATH = "/mcp";

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
      "Read runtime events from an attached Frond runtime, oldest first. Page forward by passing the returned nextSince back as since. Every filter is an exact match and they combine with AND. A record's failures array holds what went wrong as a chain of causes, outermost first; read its message field before its frames, because the outermost cause is usually a wrapper with nothing in it. Signals published on the runtime's message bus carry channel and name alongside tag, so they can be filtered without reading any payload: category signal is every publication, channel narrows to one bus, name to one kind of message. Both fields are absent on events that are not about a signal.",
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
      /**
       * A signal channel, e.g. "app.analytics". Matches only signal events, so
       * it needs no `category: "signal"` alongside it.
       */
      channel: Schema.optionalKey(Schema.String),
      /** A signal's event name, e.g. "checkout_started". */
      name: Schema.optionalKey(Schema.String),
    }),
    success: EventPage,
    failure: McpReadError,
    failureMode: "return",
  })
);

const ReadWork = readOnly(
  Tool.make("frond_read_work", {
    description:
      "Read every event belonging to one unit of runtime work, oldest first. A workId groups a whole acquire/refresh/action cascade, so this is the tool for 'what actually happened when that failed'. A long cascade pages like frond_read_events does: pass the returned nextSince back as since.",
    parameters: Schema.Struct({
      workId: Schema.Int,
      attachmentId: Schema.optionalKey(Schema.String),
      /**
       * Exclusive, and not optional in practice for a deep cascade. The response
       * carries `nextSince` and `hasMore` like every other page here, so a
       * caller that follows them has to have somewhere to put the cursor —
       * without this the tail past `limit` is unreachable and a caller doing the
       * documented thing re-reads the same page forever.
       */
      since: Schema.optionalKey(Schema.Int),
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
        runtimes: rows(attachments).map(([view, ring]) => summarize(view, ring, selfInstanceId)),
      })),

    frond_read_events: (params) =>
      Effect.map(resolve(attachments, selfInstanceId, params.attachmentId), ([view, ring]) =>
        page(view, ring, eventReadOptions(params))
      ),

    frond_read_work: (params) =>
      Effect.map(resolve(attachments, selfInstanceId, params.attachmentId), ([view, ring]) =>
        page(view, ring, {
          since: params.since,
          limit: clampLimit(params.limit),
          workId: params.workId,
        })
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
