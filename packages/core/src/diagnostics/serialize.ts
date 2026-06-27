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

function serializeCauseChainUnsafe(
  error: unknown,
  options: NormalizedCauseSerializationOptions
): ReadonlyArray<SerializedCauseFrame> {
  const frames: Array<SerializedCauseFrame> = [];
  let current: unknown = error;

  for (let index = 0; index < options.maxDepth; index += 1) {
    frames.push(frameFromValue(current, index, options));

    const next = safeGet(current, "cause");

    if (next === undefined) {
      break;
    }

    current = next;
  }

  return frames;
}

function frameFromValue(
  value: unknown,
  index: number,
  options: NormalizedCauseSerializationOptions
): SerializedCauseFrame {
  const tag = safeString(safeGet(value, "_tag"), options.maxStringLength);
  const kind = safeString(safeGet(value, "kind"), options.maxStringLength);
  const name = errorName(value, options.maxStringLength);
  const message = safeMessage(value, options.maxStringLength);
  const stack = safeString(safeGet(value, "stack"), options.maxStackLength);
  const nodeId = safeString(safeGet(value, "nodeId"), options.maxStringLength);
  const nodeTag = safeString(safeGet(value, "tag"), options.maxStringLength);
  const operation = safeString(safeGet(value, "operation"), options.maxStringLength);
  const dependency = safeString(safeGet(value, "dependency"), options.maxStringLength);
  const invariant = safeString(safeGet(value, "invariant"), options.maxStringLength);
  const boundary = safeString(safeGet(value, "boundary"), options.maxStringLength);
  const cancellation = cancellationFromValue(safeGet(value, "cancellation"), options);
  const timeout = safeString(safeGet(value, "timeout"), options.maxStringLength);
  const path = safeStringArray(safeGet(value, "path"), options.maxStringLength);

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
    dependency,
    invariant,
    boundary,
    cancellation,
    path,
    timeout,
    preview: safePreview(value, options),
  };
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
