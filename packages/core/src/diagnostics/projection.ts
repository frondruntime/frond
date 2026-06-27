import { Match } from "effect";
import { safeGet, safeMessage } from "./safe";
import { serializeCauseChain } from "./serialize";
import type { FrondErrorProjection, FrondErrorProjectionKind, SerializedCauseFrame } from "./types";

type ProjectionInput = {
  readonly causeChain: ReadonlyArray<SerializedCauseFrame>;
  readonly raw: unknown;
};

type ProjectionKindSignal =
  | { readonly _tag: "RuntimeReadWrapper"; readonly kind: "invalid" | "readiness" | "runtime" }
  | { readonly _tag: "RuntimeUnavailable" }
  | { readonly _tag: "InvalidGraph" }
  | { readonly _tag: "OperationFailure" }
  | { readonly _tag: "LiveFailure" }
  | { readonly _tag: "ReadinessFailure" }
  | { readonly _tag: "Unexpected" };

const projectionFailureMessage = "Unexpected diagnostics projection failure";

const wrapperTags = new Set([
  "AcquireFailed",
  "ActionFailed",
  "DependencyFailed",
  "DependencyDefinitionFailures",
  "DependencyFailures",
  "DisposerFailed",
  "DriverPromiseFailed",
  "DriverOperationTimedOut",
  "EffectBoundaryFailed",
  "KeyBuildFailed",
  "LiveDeliveryFailed",
  "RefreshFailed",
  "UpdateNodeArgsFailed",
  "UnsafeUpdateNodeFailed",
]);

const operationFailureTags = new Set([
  "ActionFailed",
  "DisposerFailed",
  "RefreshFailed",
  "UpdateNodeArgsFailed",
  "UnsafeUpdateNodeFailed",
]);

const readinessFailureTags = new Set([
  "AcquireFailed",
  "DependencyDefinitionFailures",
  "DependencyFailed",
  "DependencyFailures",
]);

export function projectError(error: unknown): FrondErrorProjection {
  try {
    return projectErrorUnsafe({
      causeChain: serializeCauseChain(error),
      raw: error,
    });
  } catch (cause) {
    return diagnosticsProjectionFailure(error, cause);
  }
}

export function diagnosticsProjectionFailure(
  original: unknown,
  cause: unknown
): FrondErrorProjection {
  const causeChain = serializeCauseChain(cause);

  return {
    headline: projectionFailureMessage,
    summary:
      "Frond diagnostics failed while projecting an error. The original value is preserved as a safe preview.",
    kind: "unexpected",
    retryable: false,
    rootTag: "DiagnosticsProjectionFailed",
    rootMessage: safeMessage(cause),
    raw: original,
    causeChain,
  };
}

function projectErrorUnsafe(input: ProjectionInput): FrondErrorProjection {
  const root = chooseRootFrame(input.causeChain);
  const wrapper = input.causeChain[0];
  const kind = projectionKind(input.causeChain);
  const retryable =
    wrapper?.tag === "FrondRuntimeReadError" && safeGet(input.raw, "retryable") === true;
  const rootTag = frameTag(root);
  const rootMessage = root?.invariant ?? root?.message ?? rootTag;
  const headline = projectionHeadline({ kind, rootTag, raw: input.raw });
  const summary = projectionSummary(headline, root, input.causeChain);

  // Single pass over the cause chain to find the first defined value for each
  // contextual field, instead of allocating five throwaway arrays via map+find.
  const firstFields = firstDefinedFields(input.causeChain);

  return {
    headline,
    summary,
    kind,
    retryable,
    rootTag,
    rootMessage,
    nodeId: firstFields.nodeId,
    nodeTag: firstFields.nodeTag,
    operation: firstFields.operation,
    dependency: firstFields.dependency,
    path: firstFields.path,
    raw: input.raw,
    causeChain: input.causeChain,
  };
}

interface FirstDefinedFrameFields {
  nodeId: SerializedCauseFrame["nodeId"];
  nodeTag: SerializedCauseFrame["nodeTag"];
  operation: SerializedCauseFrame["operation"];
  dependency: SerializedCauseFrame["dependency"];
  path: SerializedCauseFrame["path"];
}

function firstDefinedFields(frames: ReadonlyArray<SerializedCauseFrame>): FirstDefinedFrameFields {
  const fields: FirstDefinedFrameFields = {
    nodeId: undefined,
    nodeTag: undefined,
    operation: undefined,
    dependency: undefined,
    path: undefined,
  };

  for (const frame of frames) {
    if (fields.nodeId === undefined && frame.nodeId !== undefined) {
      fields.nodeId = frame.nodeId;
    }
    if (fields.nodeTag === undefined && frame.nodeTag !== undefined) {
      fields.nodeTag = frame.nodeTag;
    }
    if (fields.operation === undefined && frame.operation !== undefined) {
      fields.operation = frame.operation;
    }
    if (fields.dependency === undefined && frame.dependency !== undefined) {
      fields.dependency = frame.dependency;
    }
    if (fields.path === undefined && frame.path !== undefined) {
      fields.path = frame.path;
    }

    if (
      fields.nodeId !== undefined &&
      fields.nodeTag !== undefined &&
      fields.operation !== undefined &&
      fields.dependency !== undefined &&
      fields.path !== undefined
    ) {
      break;
    }
  }

  return fields;
}

function projectionKind(frames: ReadonlyArray<SerializedCauseFrame>): FrondErrorProjectionKind {
  return Match.value(projectionKindSignal(frames)).pipe(
    Match.tag("RuntimeReadWrapper", ({ kind }) => kind),
    Match.tag("RuntimeUnavailable", () => "runtime" as const),
    Match.tag("InvalidGraph", () => "invalid" as const),
    Match.tag("OperationFailure", () => "operation" as const),
    Match.tag("LiveFailure", () => "live" as const),
    Match.tag("ReadinessFailure", () => "readiness" as const),
    Match.tag("Unexpected", () => "unexpected" as const),
    Match.exhaustive
  );
}

function projectionKindSignal(frames: ReadonlyArray<SerializedCauseFrame>): ProjectionKindSignal {
  const wrapper = frames[0];

  if (
    wrapper?.tag === "FrondRuntimeReadError" &&
    (wrapper.kind === "readiness" || wrapper.kind === "invalid" || wrapper.kind === "runtime")
  ) {
    return { _tag: "RuntimeReadWrapper", kind: wrapper.kind };
  }

  if (hasFrameTag(frames, "FrondRuntimeUnavailable")) {
    return { _tag: "RuntimeUnavailable" };
  }

  if (
    hasFrameTag(frames, "CycleDetected") ||
    hasFrameTag(frames, "KeyBuildFailed") ||
    frames.some((frame) => frame.tag?.startsWith("Key") === true)
  ) {
    return { _tag: "InvalidGraph" };
  }

  if (frames.some((frame) => operationFailureTags.has(frameTag(frame)))) {
    return { _tag: "OperationFailure" };
  }

  if (hasFrameTag(frames, "LiveDeliveryFailed")) {
    return { _tag: "LiveFailure" };
  }

  if (frames.some((frame) => readinessFailureTags.has(frameTag(frame)))) {
    return { _tag: "ReadinessFailure" };
  }

  return { _tag: "Unexpected" };
}

function projectionHeadline(input: {
  readonly kind: FrondErrorProjectionKind;
  readonly rootTag: string;
  readonly raw: unknown;
}): string {
  return Match.value(input).pipe(
    Match.when(
      ({ rootTag }) => rootTag === "CycleDetected",
      () => "Dependency cycle detected"
    ),
    Match.when(
      ({ rootTag }) => rootTag.startsWith("Key") || rootTag === "KeyBuildFailed",
      () => "Invalid node key"
    ),
    Match.when({ kind: "runtime" }, () => "Runtime unavailable"),
    Match.when({ kind: "readiness" }, () => "Readiness failed"),
    Match.when({ kind: "operation" }, () => "Operation failed"),
    Match.when({ kind: "live" }, () => "Live work failed"),
    Match.when(
      ({ raw }) => raw instanceof Error,
      ({ raw }) => `Unexpected error: ${raw instanceof Error ? raw.name : "Error"}`
    ),
    Match.when(
      ({ raw }) => typeof raw === "object" && raw !== null,
      () => "Unexpected thrown object"
    ),
    Match.orElse(() => "Unexpected thrown value")
  );
}

function projectionSummary(
  headline: string,
  root: SerializedCauseFrame | undefined,
  frames: ReadonlyArray<SerializedCauseFrame>
): string {
  if (root?.tag === "CycleDetected") {
    const pathLabel =
      root.path === undefined || root.path.length === 0
        ? "unknown path"
        : root.path.map(shortNodeLabel).join(" -> ");

    return `${headline}\n${pathLabel}\nThis graph cannot be acquired until the dependency cycle is removed.`;
  }

  if (root?.invariant !== undefined) {
    return root.invariant;
  }

  if (root?.message !== undefined) {
    return root.message;
  }

  return frames[0]?.message ?? headline;
}

function chooseRootFrame(
  frames: ReadonlyArray<SerializedCauseFrame>
): SerializedCauseFrame | undefined {
  // Reverse once; both passes walk the same order so they share the copy.
  const reversed = [...frames].reverse();
  const invariantFrame = reversed.find((frame) => frame.invariant !== undefined);

  if (invariantFrame !== undefined) {
    return invariantFrame;
  }

  for (const frame of reversed) {
    const tag = frameTag(frame);

    if (!wrapperTags.has(tag) && tag !== "FrondRuntimeReadError") {
      return frame;
    }
  }

  return frames.at(-1);
}

export function frameTag(frame: SerializedCauseFrame | undefined): string {
  return frame?.tag ?? frame?.name ?? frame?.valueKind ?? "Unknown";
}

function hasFrameTag(frames: ReadonlyArray<SerializedCauseFrame>, tag: string): boolean {
  return frames.some((frame) => frameTag(frame) === tag);
}

function shortNodeLabel(value: string): string {
  const [tag] = value.split(":");

  if (tag === undefined) {
    return value;
  }

  return tag.split("/").at(-1) ?? tag;
}
