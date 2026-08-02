import type { EncodedEventRecord } from "@frondruntime/devtools";

/**
 * How many records the hub keeps per attachment.
 *
 * The hub is a devtools daemon, not a log store: the point of retention is that
 * an agent can ask about something that already happened, not that history is
 * durable. Ten thousand records is roughly a minute of a busy graph and a long
 * time on an idle one, at a memory cost measured in megabytes.
 */
export const RETAINED_PER_ATTACHMENT = 10_000;

/**
 * How far past capacity the buffer is allowed to grow before it is trimmed.
 *
 * Trimming is a `splice` from the front, which moves every surviving element.
 * Doing that once per batch would be O(capacity) at the flush rate; doing it
 * once per slack window makes it amortized O(1) per record, at the cost of a
 * buffer that is briefly a few percent over its nominal size.
 */
const TRIM_SLACK = 512;

export type EventWindow = {
  readonly records: ReadonlyArray<EncodedEventRecord>;
  /**
   * Sequence of the oldest record the hub still holds, or undefined when it
   * holds none.
   *
   * The reason this is on every read: an agent that asks for events since
   * sequence 5 and gets records starting at 900 must be able to tell that the
   * gap is the hub's retention, not a quiet period. Without this the answer is
   * indistinguishable from "nothing happened".
   */
  readonly oldestRetainedSequence: number | undefined;
  /** Records this attachment sent that the hub has since evicted. */
  readonly evictedCount: number;
  /** True when `limit` cut the result short — there is more after the last row. */
  readonly hasMore: boolean;
};

export type ReadOptions = {
  /** Exclusive: only records with a strictly greater sequence are returned. */
  readonly since?: number | undefined;
  readonly limit: number;
  /** Exact `RuntimeEvent` `_tag` match. */
  readonly tag?: string | undefined;
  readonly category?: string | undefined;
  readonly severity?: string | undefined;
  readonly workId?: number | undefined;
  readonly nodeId?: string | undefined;
  /**
   * A signal channel and event name, which only signal events carry.
   *
   * Matched against the record's own lifted fields rather than against anything
   * in `fields`: the two exist on the wire precisely so a reader can select a
   * signal without the app's value policy having a say, and a filter that
   * reached into `fields` would work at `"full"` and quietly match nothing at
   * `"shape"`.
   */
  readonly channel?: string | undefined;
  readonly name?: string | undefined;
};

/**
 * A bounded, sequence-ordered window over one attachment's events.
 *
 * Deliberately not observable and deliberately not part of `AttachmentView`:
 * the view is replaced wholesale on every batch so Ink can re-render from a
 * frozen value, and threading ten thousand records through that would copy the
 * history four times a second to feed a table that shows a count. The ring is
 * mutated in place inside the same action, so it stays serialized by the cell
 * actor without pretending to be reactive state.
 */
export class EventRing {
  private records: Array<EncodedEventRecord> = [];
  private evicted = 0;

  constructor(private readonly capacity: number = RETAINED_PER_ATTACHMENT) {}

  push(batch: ReadonlyArray<EncodedEventRecord>): void {
    this.records.push(...batch);

    if (this.records.length > this.capacity + TRIM_SLACK) {
      const excess = this.records.length - this.capacity;
      this.records.splice(0, excess);
      this.evicted += excess;
    }
  }

  get size(): number {
    return this.records.length;
  }

  get evictedCount(): number {
    return this.evicted;
  }

  get oldestRetainedSequence(): number | undefined {
    return this.records[0]?.sequence;
  }

  get newestSequence(): number | undefined {
    return this.records[this.records.length - 1]?.sequence;
  }

  /**
   * Reads the oldest `limit` records that match, starting after `since`.
   *
   * Oldest-first rather than newest-first because the caller is reading a
   * causal chain: an agent following `since` forward walks the history in the
   * order it happened, and `hasMore` tells it whether to ask again.
   */
  read(options: ReadOptions): EventWindow {
    const start = options.since === undefined ? 0 : this.indexAfter(options.since);
    const matched: Array<EncodedEventRecord> = [];
    let hasMore = false;

    for (let index = start; index < this.records.length; index += 1) {
      const record = this.records[index];

      if (record === undefined || !matches(record, options)) {
        continue;
      }

      if (matched.length === options.limit) {
        hasMore = true;
        break;
      }

      matched.push(record);
    }

    return {
      records: matched,
      oldestRetainedSequence: this.oldestRetainedSequence,
      evictedCount: this.evicted,
      hasMore,
    };
  }

  /**
   * Index of the first record with a sequence strictly greater than `since`.
   *
   * Binary search because a caller polling with `since` set to the newest
   * sequence it has seen is the common path, and that lands at the very end of
   * a ten-thousand-element array every time. Sequences within one attachment
   * are monotonic — they come from a single runtime's counter — so the array is
   * sorted by construction.
   */
  private indexAfter(since: number): number {
    let low = 0;
    let high = this.records.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const record = this.records[mid];

      if (record !== undefined && record.sequence <= since) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }
}

function matches(record: EncodedEventRecord, options: ReadOptions): boolean {
  if (options.tag !== undefined && record.tag !== options.tag) {
    return false;
  }

  if (options.category !== undefined && record.category !== options.category) {
    return false;
  }

  if (options.severity !== undefined && record.severity !== options.severity) {
    return false;
  }

  if (options.workId !== undefined && record.workId !== options.workId) {
    return false;
  }

  if (options.nodeId !== undefined && !record.nodeIds.includes(options.nodeId)) {
    return false;
  }

  if (options.channel !== undefined && record.channel !== options.channel) {
    return false;
  }

  if (options.name !== undefined && record.name !== options.name) {
    return false;
  }

  return true;
}
