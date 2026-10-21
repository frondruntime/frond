import {
  errorName,
  normalizeOptions,
  safeGet,
  safeMessage,
  safePreview,
  safeString,
  safeStringArray,
  valueKind,
} from "./safe";
import type {
  CauseSerializationOptions,
  NormalizedCauseSerializationOptions,
  SerializedCauseFrame,
} from "./types";

export function serializeCauseChain(
  error: unknown,
  options: CauseSerializationOptions = {}
): ReadonlyArray<SerializedCauseFrame> {
  try {
    return serializeCauseChainUnsafe(error, normalizeOptions(options));
  } catch (cause) {
    return [
      {
        index: 0,
        valueKind: "projection-failure",
        name: errorName(cause),
        message: safeMessage(cause),
        preview: safePreview(cause, normalizeOptions(options)),
      },
    ];
  }
}

/**
 * One walked cause frame plus the raw value it was serialized from. Internal:
 * the projection needs raw identity (memo key, synthetic error cause) next to
 * the serialized fields.
 */
export type WalkedCauseFrame = {
  readonly frame: SerializedCauseFrame;
  readonly raw: unknown;
};

const aggregateTags: ReadonlySet<string> = new Set([
  "DependencyDefinitionFailures",
  "DependencyFailures",
]);

/** Nested aggregates serialize their members one level deep only. */
const maxAggregateNesting = 1;

function serializeCauseChainUnsafe(
  error: unknown,
  options: NormalizedCauseSerializationOptions
): ReadonlyArray<SerializedCauseFrame> {
  return walkFrames(error, options, "cause", 0).map(({ frame }) => frame);
}

/**
 * Walks the chain for projection. Follows `cause`; an aggregate without a
 * cause (`DependencyFailures`) continues into its first member, so the walk
 * always reaches a failing node. Every member stays visible through the
 * aggregate frame's `failures`.
 */
export function walkProjectionChain(
  error: unknown,
  options: CauseSerializationOptions = {}
): ReadonlyArray<WalkedCauseFrame> {
  return walkFrames(error, normalizeOptions(options), "first-member", 0);
}

function walkFrames(
  error: unknown,
  options: NormalizedCauseSerializationOptions,
  aggregate: "cause" | "first-member",
  nesting: number
): ReadonlyArray<WalkedCauseFrame> {
  const frames: Array<WalkedCauseFrame> = [];
  let current: unknown = error;

  for (let index = 0; index < options.maxDepth; index += 1) {
    frames.push({ frame: frameFromValue(current, index, options, nesting), raw: current });

    const next = nextFrameValue(current, aggregate);

    if (next === undefined) {
      break;
    }

    current = next;
  }

  return frames;
}

function nextFrameValue(value: unknown, aggregate: "cause" | "first-member"): unknown {
  const cause = safeGet(value, "cause");

  if (cause !== undefined || aggregate === "cause" || !isAggregate(value)) {
    return cause;
  }

  const failures = safeGet(value, "failures");

  return Array.isArray(failures) ? failures[0] : undefined;
}

function isAggregate(value: unknown): boolean {
  const tag = safeGet(value, "_tag");

  return typeof tag === "string" && aggregateTags.has(tag);
}

function frameFromValue(
  value: unknown,
  index: number,
  options: NormalizedCauseSerializationOptions,
  nesting: number
): SerializedCauseFrame {
  const tag = safeString(safeGet(value, "_tag"), options.maxStringLength);
  const kind = safeString(safeGet(value, "kind"), options.maxStringLength);
  const name = errorName(value, options.maxStringLength);
  const message = safeMessage(value, options.maxStringLength);
  const stack = safeString(safeGet(value, "stack"), options.maxStackLength);
  const nodeId = safeString(safeGet(value, "nodeId"), options.maxStringLength);
  const nodeTag = safeString(safeGet(value, "tag"), options.maxStringLength);
  const operation = safeString(safeGet(value, "operation"), options.maxStringLength);
  const action = safeString(safeGet(value, "action"), options.maxStringLength);
  const stage = safeString(safeGet(value, "stage"), options.maxStringLength);
  const dependency = safeString(safeGet(value, "dependency"), options.maxStringLength);
  const invariant = safeString(safeGet(value, "invariant"), options.maxStringLength);
  const boundary = safeString(safeGet(value, "boundary"), options.maxStringLength);
  const cancellation = cancellationFromValue(safeGet(value, "cancellation"), options);
  const timeout = safeString(safeGet(value, "timeout"), options.maxStringLength);
  const path = safeStringArray(
    safeGet(value, "path"),
    options.maxStringLength,
    options.maxObjectKeys
  );
  const failures = aggregateFailures(value, options, nesting);

  return {
    index,
    valueKind: valueKind(value),
    name,
    message,
    tag,
    kind,
    stack,
    nodeId,
    nodeTag,
    operation,
    action,
    stage,
    dependency,
    invariant,
    boundary,
    cancellation,
    path,
    timeout,
    failures,
    preview: safePreview(value, options),
  };
}

function aggregateFailures(
  value: unknown,
  options: NormalizedCauseSerializationOptions,
  nesting: number
): SerializedCauseFrame["failures"] {
  if (nesting >= maxAggregateNesting || !isAggregate(value)) {
    return undefined;
  }

  const failures = safeGet(value, "failures");

  if (!Array.isArray(failures)) {
    return undefined;
  }

  return failures
    .slice(0, options.maxObjectKeys)
    .map((failure) => walkFrames(failure, options, "cause", nesting + 1).map(({ frame }) => frame));
}

function cancellationFromValue(
  value: unknown,
  options: NormalizedCauseSerializationOptions
): SerializedCauseFrame["cancellation"] {
  if (value === undefined) {
    return undefined;
  }

  return {
    _tag: safeString(safeGet(value, "_tag"), options.maxStringLength),
    detail: safeString(safeGet(value, "detail"), options.maxStringLength),
  };
}
