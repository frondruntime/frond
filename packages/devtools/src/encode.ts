import type { Runtime } from "@frondruntime/core";
import { describeError } from "./cause.ts";
import { setField, UNREADABLE, WITHHELD } from "./descriptors.ts";
import { type Budget, describeFull, FULL_MAX_NODES } from "./full.ts";
import type { EncodePolicy } from "./policy.ts";
import type { EncodedEventRecord } from "./protocol.ts";
import { describeShape } from "./shape.ts";

/**
 * Applies a policy to a value.
 *
 * The three encoders this composes are deliberately separate modules: the clamp
 * that decides disclosure (`policy.ts`), the walk that says as little as it can
 * (`shape.ts`), the walk that says as much as it can (`full.ts`), and the one
 * that describes failures the same way at every policy (`cause.ts`). What is
 * left here is the wiring — which walk a policy gets, and how one runtime event
 * is laid out on the wire.
 */

/**
 * A policy, applied to one answer.
 *
 * One of these per snapshot, and one budget per record in `encodeRecord`,
 * because the budget is the thing worth bounding: what a single answer costs
 * the wire. A record with one enormous field should spend its own allowance
 * rather than be judged field by field, and two records should never be able
 * to spend each other's.
 */
export type ValueEncoder = {
  /** Ordinary app data, redacted according to the policy. */
  readonly value: (value: unknown) => unknown;
  /**
   * A failure, as a chain of causes.
   *
   * Separate from {@link value} because the runtime already knows which is
   * which, and sniffing would get it wrong: a failure that is not an `Error`
   * instance — an Effect `Cause`, a node status — reaches the value encoder as
   * an anonymous bag of keys.
   */
  readonly failure: (value: unknown) => unknown;
};

export function createValueEncoder(policy: EncodePolicy): ValueEncoder {
  // Spelled out rather than folded into the `"shape"` branch. Falling through
  // was the bug: `"none"` reached the shape encoder and emitted key lists for
  // every node in a graph snapshot, which is a description of app data by an
  // app that had said it would send none.
  if (policy === "none") {
    return { value: withheldValue, failure: noneFailure };
  }

  if (policy === "shape") {
    return { value: shapeValue, failure: shapeFailure };
  }

  const budget: Budget = { remaining: FULL_MAX_NODES };

  return {
    value: (value) => fullValue(value, budget),
    failure: (value) => fullFailure(value, budget),
  };
}

// Module-level rather than closures made per encoder: `"none"` and `"shape"`
// hold no state, and `encodeRecord` calls the `"full"` pair with its own budget.
function withheldValue(): unknown {
  return WITHHELD;
}

// Still a chain, because "there is an error here" is not the value's data.
// What crosses is what the failure names about itself — its tags, its node,
// the innermost message — and never its payload or its stack, which
// `describeError` withholds at anything below `"full"`.
function noneFailure(value: unknown): unknown {
  return describeError(value, "none");
}

function shapeValue(value: unknown): unknown {
  return describeShape(value, 0);
}

function shapeFailure(value: unknown): unknown {
  return describeError(value, "shape");
}

function fullValue(value: unknown, budget: Budget): unknown {
  return describeFull(value, 0, new Set<object>(), budget);
}

// The `seen` set is per call and shared between the two halves of that call:
// `describeError` marks each link of the chain as an ancestor, and the payload
// walk it hands off to has to see those marks or it will descend back into an
// error it is already standing on. That hand-off is a closure on purpose:
// `cause.ts` reaches the full walk only through `FullContext`.
function fullFailure(value: unknown, budget: Budget): unknown {
  const seen = new Set<object>();

  return describeError(value, "full", {
    seen,
    encodeValue: (own) => describeFull(own, 1, seen, budget),
  });
}

function encodeValueAt(policy: EncodePolicy, value: unknown, budget: Budget): unknown {
  switch (policy) {
    case "none": {
      return WITHHELD;
    }
    case "shape": {
      return describeShape(value, 0);
    }
    case "full": {
      return fullValue(value, budget);
    }
  }
}

function encodeFailureAt(policy: EncodePolicy, value: unknown, budget: Budget): unknown {
  switch (policy) {
    case "none":
    case "shape": {
      return describeError(value, policy);
    }
    case "full": {
      return fullFailure(value, budget);
    }
  }
}

/** The budget below `"full"`, where nothing reads it. Frozen, so a spend would throw. */
const UNSPENT: Budget = Object.freeze({ remaining: FULL_MAX_NODES });

/** A record with its routing fields written, waiting for `fields` and `failures`. */
type RecordDraft = {
  -readonly [K in keyof Omit<EncodedEventRecord, "fields" | "failures">]: EncodedEventRecord[K];
} & {
  fields?: EncodedEventRecord["fields"];
  failures?: EncodedEventRecord["failures"];
};

/**
 * Encodes one runtime event for the wire.
 *
 * Classification, work context, and node ids are metadata the runtime already
 * owns and are copied verbatim — they are ids and enum members, never user
 * data. A signal's channel and name join them, on the reasoning
 * `EncodedEventRecord` gives for the two fields. Only the event body goes
 * through the value encoder.
 *
 * Built field by field rather than through a {@link ValueEncoder}: this runs
 * once per runtime event, and on Hermes the encoder object, its closures, and
 * an identity object spread into the record are a cost per event. One budget
 * per record, as with an encoder.
 */
export function encodeRecord(
  record: Runtime.RuntimeEventRecord,
  policy: EncodePolicy
): EncodedEventRecord {
  const budget = policy === "full" ? { remaining: FULL_MAX_NODES } : UNSPENT;
  const event = record.event;
  const encoded: RecordDraft = {
    sequence: record.sequence,
    recordedAt: record.recordedAt,
    tag: event._tag,
    category: record.classification.category,
    severity: record.classification.severity,
    timeline: record.classification.timeline,
    reportable: record.classification.reportable,
    workId: record.work.workId,
    parentWorkId: record.work.parentWorkId,
    source: record.work.source,
    reason: record.work.reason,
    priority: record.work.priority,
    nodeIds: record.nodeIds,
  };

  // Unclamped, like every routing field above it. A signal's channel and name
  // are how a reader addresses one — the filters `frond_read_events` exposes —
  // and they are authored as constants next to the code that publishes, the
  // same standing as `tag` and `nodeIds`. What the payload holds is the value,
  // and that is what `fields` withholds a line below.
  writeSignalIdentity(encoded, event);
  encoded.fields = policy === "none" ? {} : describeFields(event, policy, budget, record.failures);
  // Failures are causes, not results: their messages are what makes a
  // devtools feed worth reading, so they are described rather than dropped —
  // including under `"none"`, whose subject is values, not what broke.
  //
  // Encoded as failures rather than as values, because that is what the
  // runtime says they are — no sniffing required. Which matters for the ones
  // that are not `Error` instances: an Effect `Cause` reaching the value
  // encoder comes out as a bag of key names.
  //
  // With `Array.map`'s semantics, which the wire output was built on: the
  // length is read once, so a failure appended while encoding is not encoded,
  // and a hole stays a hole, which goes over JSON as `null`.
  const source = record.failures;
  const length = source.length;
  const failures: Array<unknown> = new Array(length);
  for (let index = 0; index < length; index++) {
    if (index in source) {
      failures[index] = encodeFailureAt(policy, source[index], budget);
    }
  }
  encoded.failures = failures;

  // Every field is written: the literal holds all but two, assigned above.
  return encoded as EncodedEventRecord;
}

/**
 * Names the signal an event is about, where it is about one.
 *
 * Two tags, written out, rather than a rule the field walk could apply to any
 * event: a general "promote a field called `channel`" would promote whatever an
 * app happened to name that way, which is app data crossing the policy that was
 * meant to clamp it. Only these two events have a channel the runtime itself put
 * there, and `RuntimeSignalSubscriberFailureObserved` is here for the same
 * reason as the publication — a subscriber failure that cannot say which signal
 * it was handling is a failure with no subject.
 *
 * Absent rather than empty on everything else. `channel: ""` is a record
 * claiming a channel it does not have, and a reader filtering on the field would
 * have to know to treat one string as meaning "no".
 *
 * Each read on its own guard, like the field walk's: these run outside it, so
 * its guards never see them, and a getter that throws here would otherwise take
 * the whole record with it. A read that throws, or a value that is not a string,
 * costs that field — the transport takes `channel` and `name` as strings or not
 * at all.
 */
function writeSignalIdentity(encoded: RecordDraft, event: Runtime.RuntimeEvent): void {
  switch (event._tag) {
    case "RuntimeSignalPublished": {
      writeIdentityOf(encoded, readGuarded(readGuarded(event, "record"), "signal"));
      return;
    }
    case "RuntimeSignalSubscriberFailureObserved": {
      writeIdentityOf(encoded, readGuarded(readGuarded(event, "signal"), "signal"));
      return;
    }
    default: {
      return;
    }
  }
}

function writeIdentityOf(encoded: RecordDraft, signal: unknown): void {
  const channel = readGuarded(signal, "channel");
  const name = readGuarded(signal, "name");

  if (typeof channel === "string") {
    encoded.channel = channel;
  }

  if (typeof name === "string") {
    encoded.name = name;
  }
}

/** `target[key]`, or `undefined` when `target` is not an object or the read throws. */
function readGuarded(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null) {
    return undefined;
  }

  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The event body, each field through the value walk.
 *
 * The runtime pulls `failures` straight off the event's own fields, so the
 * same object arrives twice — once as `fields.error`, once as `failures[0]`.
 * Matched by identity so both come out as the same thing; a record that
 * described one failure two different ways would read as two.
 */
function describeFields(
  event: Runtime.RuntimeEvent,
  policy: EncodePolicy,
  budget: Budget,
  failures: ReadonlyArray<unknown>
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const keys = Object.keys(event);

  // Each read guarded on its own. The read runs before the value walk, so the
  // walk's guards never see a getter that throws here, and the throw would
  // otherwise take the whole record with it.
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as string;

    if (key === "_tag") {
      continue;
    }

    let value: unknown;

    try {
      value = (event as unknown as Record<string, unknown>)[key];
    } catch {
      setField(fields, key, UNREADABLE);
      continue;
    }

    setField(
      fields,
      key,
      typeof value === "object" && value !== null && failures.includes(value)
        ? encodeFailureAt(policy, value, budget)
        : encodeValueAt(policy, value, budget)
    );
  }

  return fields;
}
