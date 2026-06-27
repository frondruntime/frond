import type { CauseSerializationOptions, NormalizedCauseSerializationOptions } from "./types";

export const defaultMaxDepth = 8;
export const defaultMaxStringLength = 1_024;
export const defaultMaxStackLength = 4_096;
export const defaultMaxObjectKeys = 20;

const sensitiveKeyPattern = /authorization|cookie|password|secret|token/i;

export function normalizeOptions(
  options: CauseSerializationOptions
): NormalizedCauseSerializationOptions {
  return {
    maxDepth: options.maxDepth ?? defaultMaxDepth,
    maxStringLength: options.maxStringLength ?? defaultMaxStringLength,
    maxStackLength: options.maxStackLength ?? defaultMaxStackLength,
    maxObjectKeys: options.maxObjectKeys ?? defaultMaxObjectKeys,
  };
}

export function errorName(value: unknown, maxLength = defaultMaxStringLength): string | undefined {
  if (value instanceof Error) {
    return truncate(value.name, maxLength);
  }

  return safeString(safeGet(value, "name"), maxLength);
}

export function safeMessage(value: unknown, maxLength = defaultMaxStringLength): string {
  if (value instanceof Error) {
    return truncate(value.message, maxLength);
  }

  const message = safeString(safeGet(value, "message"), maxLength);

  if (message !== undefined) {
    return message;
  }

  if (typeof value === "string") {
    return truncate(value, maxLength);
  }

  return valueKind(value);
}

export function safePreview(value: unknown, options: NormalizedCauseSerializationOptions): unknown {
  return safePreviewAtDepth(value, options, new WeakSet<object>(), 0);
}

export function safeGet(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[key];
  } catch (cause) {
    return `[Thrown while reading ${key}: ${safeMessage(cause)}]`;
  }
}

export function safeString(value: unknown, maxLength = defaultMaxStringLength): string | undefined {
  if (typeof value === "string") {
    return truncate(value, maxLength);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return truncate(String(value), maxLength);
  }

  return undefined;
}

export function safeStringArray(
  value: unknown,
  maxLength: number
): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((entry) => safeString(entry, maxLength) ?? String(entry));
}

export function valueKind(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value instanceof Error) {
    return "Error";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safePreviewAtDepth(
  value: unknown,
  options: NormalizedCauseSerializationOptions,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (depth >= options.maxDepth) {
    return "[MaxDepth]";
  }

  if (value === null || typeof value !== "object") {
    return safeScalar(value, options.maxStringLength);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, options.maxStringLength),
      stack: truncate(value.stack ?? "", options.maxStackLength),
      cause: safePreviewAtDepth(safeGet(value, "cause"), options, seen, depth + 1),
    };
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, options.maxObjectKeys)
      .map((entry) => safePreviewAtDepth(entry, options, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  const keys = safeKeys(value).slice(0, options.maxObjectKeys);

  for (const key of keys) {
    output[key] = sensitiveKeyPattern.test(key)
      ? "[Redacted]"
      : safePreviewAtDepth(safeGet(value, key), options, seen, depth + 1);
  }

  return output;
}

function safeScalar(value: unknown, maxLength: number): unknown {
  if (typeof value === "string") {
    return truncate(value, maxLength);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === undefined) {
    return value;
  }

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  return value;
}

function safeKeys(value: object): ReadonlyArray<string> {
  try {
    return Object.keys(value).sort();
  } catch {
    return [];
  }
}
