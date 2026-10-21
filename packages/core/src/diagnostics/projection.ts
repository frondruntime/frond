import { Match } from "effect";
import { isKeyError } from "../keys";
import { safeGet, safeMessage, safeString } from "./safe";
import { serializeCauseChain, type WalkedCauseFrame, walkProjectionChain } from "./serialize";
import type {
  FrondErrorNodeRef,
  FrondErrorProjection,
  FrondErrorProjectionKind,
  SerializedCauseFrame,
} from "./types";

type ProjectionKindSignal =
  | { readonly _tag: "RuntimeReadWrapper"; readonly kind: "invalid" | "readiness" | "runtime" }
  | { readonly _tag: "RuntimeUnavailable" }
  | { readonly _tag: "InvalidGraph" }
  | { readonly _tag: "OperationFailure" }
  | { readonly _tag: "LiveFailure" }
  | { readonly _tag: "ReadinessFailure" }
  | { readonly _tag: "Unexpected" };

/**
 * Frond frames say *where* (node, operation, dependency, requester). Carriers
 * are anonymous wrappers that may say *what happened* but never *what kind*.
 * App frames are everything else and carry the app's classification.
 */
type FrameClass = "frond" | "carrier" | "app";

type ClassifiedFrame = WalkedCauseFrame & {
  readonly frameClass: FrameClass;
  readonly type: string;
};

const projectionFailureMessage = "Unexpected diagnostics projection failure";

/** Type assigned to a cause Frond cannot classify. */
export const unclassifiedCauseType = "Error";

const frondFrameTags: ReadonlySet<string> = new Set([
  // Graph failures.
  "AcquireFailed",
  "ActionFailed",
  "CycleDetected",
  "DependencyDefinitionFailed",
  "DependencyDefinitionFailures",
  "DependencyFailed",
  "DependencyFailures",
  "DependencyRefreshFailed",
  "DependencyResultExpired",
  "DisposerFailed",
  "DisposerTimedOut",
  "DriverOperationTimedOut",
  "DriverPromiseFailed",
  "DuplicateNodeTag",
  "EffectBoundaryFailed",
  "GraphConfigInvalid",
  "GraphInvariantViolation",
  "KeyBuildFailed",
  "LiveDeliveryFailed",
  "NodeConstructionFailed",
  "NodeEvicted",
  "RefreshFailed",
  "ReleaseFailed",
  "ResultExpired",
  "SpecOverrideFailed",
  "UnsafeUpdateNodeFailed",
  "UpdateNodeArgsFailed",
  // Runtime and adapter failures.
  "AsyncSignalSubscriberFailed",
  "FrondNodeNotReady",
  "FrondRuntimeClosed",
  "FrondRuntimeInvariantViolation",
  "FrondRuntimeReadError",
  "FrondRuntimeUnavailable",
  "RuntimeReportSinkHandlerFailed",
]);

const carrierNames: ReadonlySet<string> = new Set(["Error", "UnknownError"]);

/** Effect's `UnknownError` default text carries no information. */
const boilerplateMessagePattern = /^An error occurred in Effect\.[A-Za-z]+$/;

const operationFailureTags = new Set([
  "ActionFailed",
  "DisposerFailed",
  "RefreshFailed",
  "ReleaseFailed",
  "UpdateNodeArgsFailed",
  "UnsafeUpdateNodeFailed",
]);

const readinessFailureTags = new Set([
  "AcquireFailed",
  "DependencyDefinitionFailures",
  "DependencyFailed",
  "DependencyFailures",
]);

/** Operation named by a Frond wrapper's type when no frame carries one. */
const wrapperOperations: Readonly<Record<string, string>> = {
  AcquireFailed: "acquire",
  DependencyDefinitionFailed: "deps",
  DependencyDefinitionFailures: "deps",
  DisposerFailed: "dispose",
  DisposerTimedOut: "dispose",
  KeyBuildFailed: "key",
  NodeConstructionFailed: "construct",
  RefreshFailed: "refresh",
  ReleaseFailed: "release",
  UnsafeUpdateNodeFailed: "unsafeUpdate",
  UpdateNodeArgsFailed: "updateArgs",
};

export function projectError(error: unknown): FrondErrorProjection {
  try {
    return projectErrorUnsafe(error);
  } catch (cause) {
    return diagnosticsProjectionFailure(error, cause);
  }
}

export function diagnosticsProjectionFailure(
  original: unknown,
  cause: unknown
): FrondErrorProjection {
  const causeChain = serializeCauseChain(cause);
  const causeMessage = safeMessage(cause);

  return {
    headline: projectionFailureMessage,
    summary:
      "Frond diagnostics failed while projecting an error. The original value is preserved as a safe preview.",
    kind: "unexpected",
    retryable: false,
    causeType: "DiagnosticsProjectionFailed",
    causeMessage,
    path: [],
    failingFailure: original,
    rootTag: "DiagnosticsProjectionFailed",
    rootMessage: causeMessage,
    raw: original,
    causeChain,
  };
}

function projectErrorUnsafe(raw: unknown): FrondErrorProjection {
  const frames = walkProjectionChain(raw).map(classifyFrame);
  const failingIndex = findLastIndex(frames, isNodeFrame);
  const failing = frames[failingIndex];
  const blockStart = failing === undefined ? 0 : failingBlockStart(frames, failingIndex);
  // Frames from the failing node's own Frond frames inward. Kind, cause, and
  // operation come from here so every requester of one failure projects alike.
  const own = frames.slice(blockStart);
  const anchor = failing === undefined ? findLastIndex(frames, isFrondFrame) : failingIndex;
  // An invariant violation is Frond itself as the cause; its `cause` is
  // diagnostic data, not an app error, so the chain is treated as ending there.
  const invariantEnd = frames[anchor]?.frame.invariant !== undefined;
  const terminal = invariantEnd ? frames[anchor] : frames.at(-1);
  const below = invariantEnd ? [] : frames.slice(anchor + 1);
  const kind = projectionKindFrom(own, frames);
  const causeTypeFrame = below.find((frame) => frame.frameClass === "app");
  const causeType =
    causeTypeFrame?.type ??
    (terminal?.frameClass === "frond" ? terminal.type : unclassifiedCauseType);
  const headline = projectionHeadline({ kind, terminal, causeType, raw });
  const messageFrame = findLast(below, hasCauseMessage);
  const causeMessage = projectedCauseMessage({ messageFrame, causeType, terminal, headline });
  const failingNode = failing === undefined ? undefined : nodeRef(failing.frame);
  const wrapper = frames[0];
  const retryable =
    wrapper?.frame.tag === "FrondRuntimeReadError"
      ? safeGet(wrapper.raw, "retryable") === true
      : kind === "readiness";

  return {
    headline,
    summary: projectionSummary({ headline, terminal, causeMessage }),
    kind,
    retryable,
    causeType,
    causeMessage,
    messageType: messageFrame?.type,
    stack: messageFrame?.frame.stack ?? causeTypeFrame?.frame.stack ?? terminal?.frame.stack,
    failingNode,
    requester: requesterRef(frames),
    path: nodePath(frames, failingIndex),
    operation:
      failing === undefined ? undefined : failingOperation(frames, blockStart, failingIndex),
    dependency: findLast(
      frames.slice(0, failingIndex + 1),
      (frame) => frame.frame.dependency !== undefined
    )?.frame.dependency,
    failingFailure: frames[blockStart]?.raw ?? raw,
    rootTag: causeType,
    rootMessage: causeMessage,
    nodeId: failingNode?.id,
    nodeTag: failingNode?.tag,
    raw,
    causeChain: serializeCauseChain(raw),
  };
}

function classifyFrame(walked: WalkedCauseFrame): ClassifiedFrame {
  const { frame, raw } = walked;

  if (frame.tag !== undefined && (frondFrameTags.has(frame.tag) || isKeyErrorFrame(frame))) {
    return { ...walked, frameClass: "frond", type: frame.tag };
  }

  if (frame.valueKind === "Error" && frame.name !== undefined && carrierNames.has(frame.name)) {
    if (frame.tag === undefined || frame.tag === "UnknownError") {
      return { ...walked, frameClass: "carrier", type: frame.name };
    }
  }

  return { ...walked, frameClass: "app", type: appFrameType(frame, raw) };
}

function appFrameType(frame: SerializedCauseFrame, raw: unknown): string {
  if (frame.tag !== undefined) {
    return frame.tag;
  }

  if (frame.name !== undefined && frame.name.length > 0) {
    return frame.name;
  }

  if (raw === null) {
    return "ThrownNull";
  }

  const kind = typeof raw;

  return `Thrown${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function isFrondFrame(frame: ClassifiedFrame): boolean {
  return frame.frameClass === "frond";
}

function isNodeFrame(frame: ClassifiedFrame): boolean {
  return (
    isFrondFrame(frame) && frame.frame.nodeId !== undefined && frame.frame.nodeTag !== undefined
  );
}

/** Outermost index of the contiguous Frond frames sharing the failing node id. */
function failingBlockStart(frames: ReadonlyArray<ClassifiedFrame>, failingIndex: number): number {
  const nodeId = frames[failingIndex]?.frame.nodeId;
  let start = failingIndex;

  while (start > 0) {
    const previous = frames[start - 1];

    // A reader's `FrondRuntimeReadError` is the requester's view, even when it
    // reads the failing node itself; it never belongs to the failure, so the
    // sink event and the reader resolve to the same failure object.
    if (
      previous === undefined ||
      !isFrondFrame(previous) ||
      previous.frame.tag === "FrondRuntimeReadError" ||
      previous.frame.nodeId !== nodeId
    ) {
      break;
    }

    start -= 1;
  }

  return start;
}

/** The value's own message, never a value-kind placeholder. */
function rawMessage(frame: ClassifiedFrame): string | undefined {
  const { raw } = frame;

  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return safeString(raw);
  }

  if (typeof raw === "bigint") {
    return safeString(raw);
  }

  return safeString(safeGet(raw, "message"));
}

function hasCauseMessage(frame: ClassifiedFrame): boolean {
  if (frame.frameClass === "frond") {
    return false;
  }

  const message = rawMessage(frame);

  return (
    message !== undefined &&
    message.trim().length > 0 &&
    !(frame.frameClass === "carrier" && boilerplateMessagePattern.test(message))
  );
}

function projectedCauseMessage(input: {
  readonly messageFrame: ClassifiedFrame | undefined;
  readonly causeType: string;
  readonly terminal: ClassifiedFrame | undefined;
  readonly headline: string;
}): string {
  const { messageFrame, terminal } = input;

  if (messageFrame !== undefined) {
    const message = rawMessage(messageFrame) ?? "";

    return messageFrame.type === input.causeType || messageFrame.frameClass === "carrier"
      ? message
      : `${messageFrame.type}: ${message}`;
  }

  if (terminal?.frameClass !== "frond") {
    return "";
  }

  if (terminal.frame.tag === "CycleDetected") {
    return input.headline;
  }

  // Key errors carry a generated, value-free message (the input path and the
  // reason); it says which arg is wrong, so it is the message, not the headline.
  if (isKeyErrorFrame(terminal.frame)) {
    return rawMessage(terminal) ?? input.headline;
  }

  return (
    terminal.frame.invariant ?? stripNodePrefix(rawMessage(terminal) ?? "", terminal.frame.nodeTag)
  );
}

function stripNodePrefix(message: string, nodeTag: string | undefined): string {
  const prefix = nodeTag === undefined ? undefined : `${nodeTag}: `;

  return prefix !== undefined && message.startsWith(prefix)
    ? message.slice(prefix.length)
    : message;
}

function nodeRef(frame: SerializedCauseFrame): FrondErrorNodeRef | undefined {
  return frame.nodeId === undefined ? undefined : { id: frame.nodeId, tag: frame.nodeTag };
}

function requesterRef(frames: ReadonlyArray<ClassifiedFrame>): FrondErrorNodeRef | undefined {
  const outer = frames.find((frame) => isFrondFrame(frame) && frame.frame.nodeId !== undefined);

  if (outer === undefined || outer.frame.nodeId === undefined) {
    return undefined;
  }

  // A read wrapper carries only the node id; the next frame of the same node
  // carries its tag.
  const tag =
    outer.frame.nodeTag ??
    frames.find((frame) => frame.frame.nodeId === outer.frame.nodeId && frame.frame.nodeTag)?.frame
      .nodeTag;

  return { id: outer.frame.nodeId, tag };
}

function nodePath(
  frames: ReadonlyArray<ClassifiedFrame>,
  failingIndex: number
): ReadonlyArray<string> {
  const path: Array<string> = [];

  for (const frame of frames.slice(0, failingIndex + 1)) {
    const tag = frame.frame.nodeTag;

    if (isFrondFrame(frame) && tag !== undefined && !path.includes(tag)) {
      path.push(tag);
    }
  }

  return path;
}

function failingOperation(
  frames: ReadonlyArray<ClassifiedFrame>,
  blockStart: number,
  failingIndex: number
): string | undefined {
  const block = frames.slice(blockStart, failingIndex + 1);
  const action = block.find((frame) => frame.frame.tag === "ActionFailed")?.frame.action;

  if (action !== undefined) {
    return action;
  }

  const operation = findLast(block, (frame) => frame.frame.operation !== undefined)?.frame
    .operation;

  if (operation !== undefined) {
    return operation;
  }

  for (const frame of block) {
    const tag = frame.frame.tag;

    if (tag === "LiveDeliveryFailed") {
      return frame.frame.stage === undefined ? "live" : `live.${frame.frame.stage}`;
    }

    if (tag !== undefined && wrapperOperations[tag] !== undefined) {
      return wrapperOperations[tag];
    }
  }

  return undefined;
}

function projectionKindFrom(
  own: ReadonlyArray<ClassifiedFrame>,
  all: ReadonlyArray<ClassifiedFrame>
): FrondErrorProjectionKind {
  const ownKind = projectionKind(own.map(({ frame }) => frame));

  return ownKind === "unexpected" ? projectionKind(all.map(({ frame }) => frame)) : ownKind;
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

  if (hasFrameTag(frames, "CycleDetected") || frames.some((frame) => isKeyErrorFrame(frame))) {
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
  readonly terminal: ClassifiedFrame | undefined;
  readonly causeType: string;
  readonly raw: unknown;
}): string {
  const terminalTag = input.terminal?.frame.tag;
  const terminalIsKeyError = input.terminal !== undefined && isKeyErrorFrame(input.terminal.frame);

  return Match.value({ kind: input.kind, raw: input.raw }).pipe(
    Match.when(
      () => terminalTag === "CycleDetected",
      () => "Dependency cycle detected"
    ),
    Match.when(
      () => terminalIsKeyError,
      () => "Invalid node key"
    ),
    Match.when(
      ({ kind }) => kind === "readiness" && terminalTag?.startsWith("Key") === true,
      () => `Readiness failed: ${input.causeType}`
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

function projectionSummary(input: {
  readonly headline: string;
  readonly terminal: ClassifiedFrame | undefined;
  readonly causeMessage: string;
}): string {
  const terminal = input.terminal?.frame;

  if (terminal?.tag === "CycleDetected") {
    const pathLabel =
      terminal.path === undefined || terminal.path.length === 0
        ? "unknown path"
        : terminal.path.map(shortNodeLabel).join(" -> ");

    return `${input.headline}\n${pathLabel}\nThis graph cannot be acquired until the dependency cycle is removed.`;
  }

  if (terminal?.invariant !== undefined) {
    return terminal.invariant;
  }

  return input.causeMessage.length > 0 ? input.causeMessage : input.headline;
}

export function frameTag(frame: SerializedCauseFrame | undefined): string {
  return frame?.tag ?? frame?.name ?? frame?.valueKind ?? "Unknown";
}

function hasFrameTag(frames: ReadonlyArray<SerializedCauseFrame>, tag: string): boolean {
  return frames.some((frame) => frameTag(frame) === tag);
}

function isKeyErrorFrame(frame: SerializedCauseFrame): boolean {
  return frame.tag !== undefined && isKeyError({ _tag: frame.tag });
}

function shortNodeLabel(value: string): string {
  const [tag] = value.split(":");

  if (tag === undefined) {
    return value;
  }

  return tag.split("/").at(-1) ?? tag;
}

function findLast<T>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): T | undefined {
  const index = findLastIndex(items, predicate);

  return index === -1 ? undefined : items[index];
}

function findLastIndex<T>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item !== undefined && predicate(item)) {
      return index;
    }
  }

  return -1;
}
