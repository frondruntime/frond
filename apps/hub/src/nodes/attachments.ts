import {
  type ActionContract,
  type Args,
  Driver,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
  tag,
} from "@frondruntime/core";
import type {
  AttachmentInfo,
  EncodedEventRecord,
  HubCommand,
  QueryOutcome,
} from "@frondruntime/devtools";
import { Clock, Effect, type Queue } from "effect";
import { observable, runInAction } from "mobx";
import { QueryBroker } from "../queries.ts";
import { emptyRate, type RateWindow, recordRate } from "../rate.ts";
import { EventRing } from "../retention.ts";

/**
 * What the CLI shows for one attached runtime.
 *
 * Replaced wholesale on every update rather than mutated in place: the map
 * entry is the observable unit, so a plain frozen record keeps the reactivity
 * story to exactly one level and avoids deep-observable surprises in Ink.
 */
export type AttachmentView = {
  readonly attachmentId: string;
  readonly info: AttachmentInfo;
  readonly connectedAt: number;
  readonly eventCount: number;
  /** Events the sender admitted it could not buffer. Never inferred. */
  readonly droppedCount: number;
  readonly lastSequence: number;
  readonly lastEventAt: number;
  readonly lastTag: string | undefined;
  /** Events per second over the last minute, for the list sparkline. */
  readonly rate: RateWindow;
  /**
   * The most recent records, newest last, bounded by `TAIL_LIMIT`.
   *
   * Deliberately a second, much smaller copy of what the ring already holds.
   * The division is by reader: a person scrolls a screen, so the UI gets a
   * screenful as ordinary observable state; an agent pages ten thousand
   * records, so the MCP reader gets the ring. Sharing one buffer between them
   * would mean either making the ring observable — copying its whole history
   * on every frame — or reading it imperatively mid-render, which is a
   * reactivity bug waiting for the first refactor.
   */
  readonly tail: ReadonlyArray<EncodedEventRecord>;
};

/**
 * How many recent records a view carries for the UI.
 *
 * Sized for scrollback rather than history: a terminal shows roughly twenty
 * rows, so a hundred leaves room to scroll back through a burst without
 * pretending to be the retained history.
 */
export const TAIL_LIMIT = 100;

export type AttachmentsResult = {
  readonly attachments: ReturnType<typeof observable.map<string, AttachmentView>>;
  /**
   * Retained event history, keyed by attachment id.
   *
   * A plain map, not an observable one: nothing renders it. It exists so the
   * MCP reader can answer questions about events that already scrolled past,
   * and it is mutated inside the same actions as the view above, which is what
   * keeps the two from disagreeing about what arrived.
   */
  readonly retained: Map<string, EventRing>;
  /**
   * The hub-to-app query channel, for every attachment at once.
   *
   * One broker rather than one per attachment, because a reply arrives as its
   * own unary call naming an attachment it has to be matched against — the
   * lookup is the broker's job, and splitting it per attachment would only move
   * that lookup one level up.
   *
   * Not observable, and read directly rather than through an action, unlike the
   * two above. `ask` parks the caller until the app answers or the timeout
   * expires; running that inside an action would hold the cell actor for
   * seconds and stall every ingest behind it.
   */
  readonly queries: QueryBroker;
};

type AttachmentsSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: AttachmentsResult;
  readonly actions: {
    readonly attached: ActionContract<
      {
        readonly attachmentId: string;
        readonly info: AttachmentInfo;
        readonly at: number;
        /**
         * Where hub-to-app commands for this attachment go.
         *
         * Passed in rather than made here because the `Attach` handler is what
         * merges it into the response stream: the queue belongs to the stream's
         * lifetime, and the broker only ever writes to it.
         */
        readonly outbound: Queue.Queue<HubCommand>;
      },
      void
    >;
    readonly detached: ActionContract<{ readonly attachmentId: string }, void>;
    readonly replied: ActionContract<
      {
        readonly attachmentId: string;
        readonly requestId: string;
        readonly outcome: QueryOutcome;
      },
      void
    >;
    readonly ingested: ActionContract<
      {
        readonly attachmentId: string;
        readonly records: ReadonlyArray<EncodedEventRecord>;
        readonly droppedSince: number;
      },
      void
    >;
  };
}>;

/**
 * The hub's registry of attached runtimes.
 *
 * This node exists so socket callbacks never touch graph state directly. Every
 * mutation arrives as an action, which the node cell actor serializes — the
 * same guarantee the runtime gives any other action, and the reason a burst of
 * concurrent `Ingest` calls cannot interleave halfway through an update.
 */
export class AttachmentsNode extends NodeBase<AttachmentsSpec> {
  static readonly spec = serviceSpec.effect<AttachmentsSpec>({
    tag: tag("hub/attachments"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() =>
      Effect.succeed({
        // Shallow on purpose, and now load-bearing. A deep map would convert
        // every value it is handed, which since the view gained a tail means
        // converting a hundred records into observables four times a second per
        // app — to feed a list that only ever re-reads the whole entry. The
        // entry is the observable unit; the record inside it is frozen data.
        attachments: observable.map<string, AttachmentView>(undefined, { deep: false }),
        retained: new Map<string, EventRing>(),
        queries: new QueryBroker(),
      })
    ),
    actions: {
      attached: Driver.Action((ctx, input) =>
        Effect.sync(() => {
          // A fresh ring per attachment, never reused across reconnects: a new
          // attachment is a new runtime generation with its own sequence
          // counter, and splicing two of those into one buffer would break the
          // ordering that `since` reads depend on.
          ctx.node.result.retained.set(input.attachmentId, new EventRing());
          ctx.node.result.queries.open(input.attachmentId, input.outbound);

          runInAction(() => {
            ctx.node.result.attachments.set(input.attachmentId, {
              attachmentId: input.attachmentId,
              info: input.info,
              connectedAt: input.at,
              eventCount: 0,
              droppedCount: 0,
              lastSequence: 0,
              lastEventAt: 0,
              lastTag: undefined,
              rate: emptyRate(input.at),
              tail: [],
            });
          });
        })
      ),
      detached: Driver.Action((ctx, input) =>
        Effect.sync(() => {
          // The history goes with the attachment. That loses the post-mortem
          // case — the events leading up to a crash are exactly the ones worth
          // reading — but keeping them means keeping a row for a runtime that
          // is gone, and a list that mixes live and dead attachments without
          // saying which is which is worse than no history at all. Surviving
          // detachment is its own feature, with its own tombstone.
          ctx.node.result.retained.delete(input.attachmentId);
          // Fails whatever was still waiting on this attachment, so a socket
          // that dropped mid-query is reported as a detachment now rather than
          // as a timeout in five seconds.
          ctx.node.result.queries.close(input.attachmentId);

          runInAction(() => {
            ctx.node.result.attachments.delete(input.attachmentId);
          });
        })
      ),
      // Through an action like every other socket callback, so a reply and the
      // detachment that races it cannot interleave. Settling a request the
      // detach already failed is a no-op, which is the outcome either order
      // should produce.
      replied: Driver.Action((ctx, input) =>
        Effect.sync(() => {
          ctx.node.result.queries.settle(input.attachmentId, input.requestId, input.outcome);
        })
      ),
      ingested: Driver.Action((ctx, input) =>
        Effect.gen(function* () {
          // The hub's clock, not the records' own `recordedAt`: those come from
          // another process, and a skewed sender would place its events in a
          // bucket the operator's minute does not contain. The cost is that a
          // batch is attributed to its arrival rather than its span, which at a
          // 250ms flush against 1s buckets is not visible.
          const now = yield* Clock.currentTimeMillis;

          const current = ctx.node.result.attachments.get(input.attachmentId);

          // A batch can outrace `detached` on a socket that dropped mid-flight.
          // Recreating the entry here would resurrect a dead attachment, so the
          // batch is discarded instead.
          if (current === undefined) {
            return;
          }

          const last = input.records.at(-1);

          // Outside `runInAction` on purpose: the ring is not observable, and
          // putting a non-reactive mutation inside a MobX transaction only
          // suggests it is one.
          ctx.node.result.retained.get(input.attachmentId)?.push(input.records);

          runInAction(() => {
            ctx.node.result.attachments.set(input.attachmentId, {
              ...current,
              eventCount: current.eventCount + input.records.length,
              droppedCount: current.droppedCount + input.droppedSince,
              lastSequence: last?.sequence ?? current.lastSequence,
              lastEventAt: last?.recordedAt ?? current.lastEventAt,
              lastTag: last?.tag ?? current.lastTag,
              rate: recordRate(current.rate, now, input.records.length),
              // A batch larger than the tail would otherwise be spliced twice;
              // taking the last `TAIL_LIMIT` of the concatenation keeps the
              // newest records regardless of how big the batch was.
              tail: [...current.tail, ...input.records].slice(-TAIL_LIMIT),
            });
          });
        })
      ),
    },
  });

  attached(
    attachmentId: string,
    info: AttachmentInfo,
    at: number,
    outbound: Queue.Queue<HubCommand>
  ): Effect.Effect<void, unknown> {
    return this.actions.attached({ attachmentId, info, at, outbound });
  }

  detached(attachmentId: string): Effect.Effect<void, unknown> {
    return this.actions.detached({ attachmentId });
  }

  replied(
    attachmentId: string,
    requestId: string,
    outcome: QueryOutcome
  ): Effect.Effect<void, unknown> {
    return this.actions.replied({ attachmentId, requestId, outcome });
  }

  ingested(
    attachmentId: string,
    records: ReadonlyArray<EncodedEventRecord>,
    droppedSince: number
  ): Effect.Effect<void, unknown> {
    return this.actions.ingested({ attachmentId, records, droppedSince });
  }
}
