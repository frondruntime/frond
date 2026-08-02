import { EncodedEventRecord } from "@frondruntime/devtools";
import { Effect, Schema } from "effect";
import type { AttachmentsNode, AttachmentView } from "./nodes/attachments.ts";
import type { EventRing } from "./retention.ts";

/**
 * What the MCP tools answer with, and how they decide who to answer about.
 *
 * Split from `mcp.ts` so the rules are reachable without an HTTP layer, an
 * `McpServer`, or a running runtime behind them. Every function here is pure
 * over an attachments map — which is what makes {@link resolve}'s rule about the
 * hub's own attachment testable, and that is the rule in this file most likely
 * to break quietly: getting it wrong answers "what does my graph look like" with
 * the devtools' own graph, which is a wrong answer wearing the shape of a right
 * one.
 *
 * `mcp.ts` keeps the tool descriptions and the wiring. The division is roughly
 * contract versus behaviour.
 */

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
 * Reported by every read, alongside the records.
 *
 * Two independent gap counters, because they mean different things and an agent
 * that conflates them will draw the wrong conclusion. `droppedBySender` is
 * events the attached app could not buffer — they never reached the hub.
 * `evictedByHub` is events the hub received and has since aged out. Only the
 * second can be avoided by reading sooner.
 */
export const Coverage = Schema.Struct({
  /** Sequence of the oldest record still held, absent when nothing is held. */
  oldestRetainedSequence: Schema.optional(Schema.Number),
  newestSequence: Schema.optional(Schema.Number),
  retainedCount: Schema.Number,
  evictedByHub: Schema.Number,
  droppedBySender: Schema.Number,
});

export const RuntimeSummary = Schema.Struct({
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

export const EventPage = Schema.Struct({
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

export type Row = readonly [AttachmentView, EventRing | undefined];

export function rows(attachments: AttachmentsNode): ReadonlyArray<Row> {
  const { attachments: views, retained } = attachments.result;

  return [...views.values()].map((view) => [view, retained.get(view.attachmentId)] as const);
}

/**
 * One attached runtime, as `frond_list_runtimes` reports it.
 */
export function summarize(
  view: AttachmentView,
  ring: EventRing | undefined,
  selfInstanceId: string
): typeof RuntimeSummary.Type {
  return {
    attachmentId: view.attachmentId,
    name: view.info.name,
    platform: view.info.platform,
    runtimeId: view.info.runtimeId,
    // `instanceId`, not `runtimeId`: the latter is a per-process counter, so
    // every process's first runtime is `runtime-1` and this comparison would
    // match every row.
    isHub: view.info.instanceId === selfInstanceId,
    generation: view.info.generation,
    connectedAt: view.connectedAt,
    eventCount: view.eventCount,
    lastSequence: view.lastSequence,
    lastEventAt: view.lastEventAt,
    ...(view.lastTag === undefined ? {} : { lastTag: view.lastTag }),
    values: view.info.values,
    coverage: coverageOf(view, ring),
  };
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
export function resolve(
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
            message: `No attachment ${attachmentId}. ${describeCandidates(candidates, selfInstanceId)}`,
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
    return `attachmentId is required when more than one app is attached. ${describeCandidates(apps, selfInstanceId)}`;
  }

  const hub = candidates.find(([view]) => view.info.instanceId === selfInstanceId);

  if (hub === undefined) {
    return "No runtimes are attached to this hub. Attach an app with attachDevtools({ runtime, name }) from @frondruntime/devtools, then call frond_list_runtimes.";
  }

  return `No app is attached to this hub; the only attachment is the hub's own runtime. Attach an app with attachDevtools({ runtime, name }) from @frondruntime/devtools and call frond_list_runtimes again, or pass attachmentId ${hub[0].attachmentId} to read the hub itself.`;
}

function describeCandidates(candidates: ReadonlyArray<Row>, selfInstanceId: string): string {
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

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }

  // Silently clamping beats failing: an over-large limit is a caller guessing
  // at the ceiling, and `hasMore` already tells it the answer was cut short.
  return Math.max(1, Math.min(Math.trunc(limit), MAX_LIMIT));
}

/**
 * The read options behind one `frond_read_events` call.
 *
 * Extracted from the handler for the reason `clampLimit` is: forwarding is a
 * decision, and the one mistake it can make is silent. A tool that advertises a
 * `channel` filter and then reads without it answers with a page that is shaped
 * exactly like a filtered one and is not filtered — no test of {@link page}
 * catches that, because `page` was never asked to filter in the first place.
 * Naming the mapping gives the wiring somewhere to be tested.
 */
export function eventReadOptions(params: {
  readonly since?: number | undefined;
  readonly limit?: number | undefined;
  readonly tag?: string | undefined;
  readonly category?: string | undefined;
  readonly severity?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly channel?: string | undefined;
  readonly name?: string | undefined;
}): Parameters<EventRing["read"]>[0] {
  return {
    since: params.since,
    limit: clampLimit(params.limit),
    tag: params.tag,
    category: params.category,
    severity: params.severity,
    nodeId: params.nodeId,
    channel: params.channel,
    name: params.name,
  };
}

export function page(
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

export function coverageOf(
  view: AttachmentView,
  ring: EventRing | undefined
): typeof Coverage.Type {
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
