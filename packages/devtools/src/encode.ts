import type { Runtime } from "@frondruntime/core";
import { describeError } from "./cause.ts";
import { WITHHELD } from "./descriptors.ts";
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
 * One of these per record and per snapshot, because the budget it closes over
 * is the thing worth bounding: what a single answer costs the wire. A record
 * with one enormous field should spend its own allowance rather than be judged
 * field by field, and two records should never be able to spend each other's.
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
    return {
      value: () => WITHHELD,
      // Still a chain, because "there is an error here" is not the value's
      // data. What crosses is what the failure names about itself — its tags,
      // its node, the innermost message — and never its payload or its stack,
      // which `describeError` withholds at anything below `"full"`.
      failure: (value) => describeError(value, policy),
    };
  }

  if (policy === "shape") {
    return {
      value: (value) => describeShape(value, 0),
      failure: (value) => describeError(value, policy),
    };
  }

  const budget: Budget = { remaining: FULL_MAX_NODES };

  return {
    value: (value) => describeFull(value, 0, new Set<object>(), budget),
    // The `seen` set is per call and shared between the two halves of that call:
    // `describeError` marks each link of the chain as an ancestor, and the
    // payload walk it hands off to has to see those marks or it will descend
    // back into an error it is already standing on.
    failure: (value) => {
      const seen = new Set<object>();

      return describeError(value, policy, {
        seen,
        encodeValue: (own) => describeFull(own, 1, seen, budget),
      });
    },
  };
}

/**
 * Encodes one runtime event for the wire.
 *
 * Classification, work context, and node ids are metadata the runtime already
 * owns and are copied verbatim — they are ids and enum members, never user
 * data. Only the event body goes through the value encoder.
 */
export function encodeRecord(
  record: Runtime.RuntimeEventRecord,
  policy: EncodePolicy
): EncodedEventRecord {
  const encoder = createValueEncoder(policy);

  // The runtime pulls `failures` straight off the event's own fields, so the
  // same object arrives twice — once as `fields.error`, once as `failures[0]`.
  // Matched by identity so both come out as the same thing; a record that
  // described one failure two different ways would read as two.
  const known = new Set(
    record.failures.filter(
      (failure): failure is object => typeof failure === "object" && failure !== null
    )
  );

  const encodeField = (value: unknown): unknown =>
    typeof value === "object" && value !== null && known.has(value)
      ? encoder.failure(value)
      : encoder.value(value);

  return {
    sequence: record.sequence,
    recordedAt: record.recordedAt,
    tag: record.event._tag,
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
    fields: policy === "none" ? {} : describeFields(record.event, encodeField),
    // Failures are causes, not results: their messages are what makes a
    // devtools feed worth reading, so they are described rather than dropped —
    // including under `"none"`, whose subject is values, not what broke.
    //
    // Encoded as failures rather than as values, because that is what the
    // runtime says they are — no sniffing required. Which matters for the ones
    // that are not `Error` instances: an Effect `Cause` reaching the value
    // encoder comes out as a bag of key names.
    failures: record.failures.map(encoder.failure),
  };
}

function describeFields(
  event: Runtime.RuntimeEvent,
  encodeValue: (value: unknown) => unknown
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event)) {
    if (key === "_tag") {
      continue;
    }

    fields[key] = encodeValue(value);
  }

  return fields;
}
