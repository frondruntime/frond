import { Match } from "effect";
import type { NodeId, NodeStatus } from "../graph";
import type { RuntimeEvent } from "../runtime/types";

export type RuntimeEventCategory =
  | "command"
  | "diagnostic"
  | "input"
  | "lifecycle"
  | "operation"
  | "signal"
  | "state";

export type RuntimeEventSeverity = "debug" | "error" | "info" | "warning";

export type RuntimeEventTimeline = "live" | "state" | "system" | "work";

export interface RuntimeEventClassification {
  readonly category: RuntimeEventCategory;
  readonly severity: RuntimeEventSeverity;
  readonly reportable: boolean;
  readonly timeline: RuntimeEventTimeline;
}

type RuntimeEventTag = RuntimeEvent["_tag"];
type RuntimeEventOf<TTag extends RuntimeEventTag> = Extract<RuntimeEvent, { readonly _tag: TTag }>;

interface RuntimeEventMetadata<TEvent extends RuntimeEvent> {
  readonly classify: (event: TEvent) => RuntimeEventClassification;
  readonly failures: (event: TEvent) => ReadonlyArray<unknown>;
  readonly nodeIds: (event: TEvent) => ReadonlyArray<NodeId>;
}

export function classify(event: RuntimeEvent): RuntimeEventClassification {
  return eventMetadata(event).classify(event as never);
}

export function failures(event: RuntimeEvent): ReadonlyArray<unknown> {
  return eventMetadata(event).failures(event as never);
}

export function isReportable(event: RuntimeEvent): boolean {
  return classify(event).reportable;
}

export function nodeIds(event: RuntimeEvent): ReadonlyArray<NodeId> {
  return eventMetadata(event).nodeIds(event as never);
}

const runtimeEventMetadata = {
  RuntimeStarted: fixed(lifecycle("info", "system")),
  RuntimeStopped: fixed(lifecycle("info", "state")),
  InputIngestionChanged: fixed(command("info", "system")),
  RuntimeInputReceived: fixed(input("info", "system")),
  RuntimeSignalPublished: fixed(signal("info", "system")),
  RuntimeSignalSubscriberFailureObserved: metadata({
    classification: diagnostic("error", "system"),
    failures: ({ cause }) => [cause],
  }),
  RuntimeSinkFailureObserved: metadata({
    classification: diagnostic("error", "system"),
    failures: ({ cause }) => [cause],
  }),
  RuntimeObserverFailureObserved: metadata({
    classification: diagnostic("error", "system"),
    failures: ({ cause }) => [cause],
  }),
  GraphSystemStarted: fixed(lifecycle("info", "system")),
  GraphSystemStopped: fixed(lifecycle("info", "state")),
  GraphSystemInputObserved: fixed(input("debug", "system")),
  GraphNodeEnsured: metadata({
    classify: ({ status }) =>
      nodeStatusFailure(status) === undefined
        ? command("debug", "state")
        : operation("error", "state", true),
    failures: ({ status }) => maybeFailure(nodeStatusFailure(status)),
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphNodeReadyEnsured: metadata({
    classify: ({ status }) =>
      nodeStatusFailure(status) === undefined
        ? command("debug", "state")
        : operation("error", "state", true),
    failures: ({ status }) => maybeFailure(nodeStatusFailure(status)),
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphNodeChanged: nodeEvent(state("debug", "state")),
  GraphActionStarted: nodeEvent(operation("info", "work")),
  GraphActionSucceeded: nodeEvent(operation("info", "work")),
  GraphActionFailed: metadata({
    classification: operation("error", "work", true),
    failures: ({ error }) => [error],
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphRefreshStarted: nodeEvent(operation("info", "work")),
  GraphRefreshSucceeded: nodeEvent(operation("info", "work")),
  GraphRefreshFailed: metadata({
    classification: operation("error", "work", true),
    failures: ({ error }) => [error],
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphNodeArgsUpdateStarted: nodeEvent(operation("info", "work")),
  GraphNodeArgsUpdateSucceeded: nodeEvent(operation("info", "work")),
  GraphNodeArgsUpdateFailed: metadata({
    classification: operation("error", "work", true),
    failures: ({ error }) => [error],
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphUnsafeNodeUpdated: nodeEvent(operation("info", "work")),
  GraphUnsafeNodeUpdateFailed: metadata({
    classification: operation("error", "work", true),
    failures: ({ error }) => [error],
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphNodeReleased: metadata({
    classify: ({ failure }) =>
      failure === undefined ? state("info", "state") : operation("error", "state", true),
    failures: ({ failure }) => (failure === undefined ? [] : [failure]),
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphNodesEvicted: metadata({
    classify: ({ failures }) =>
      failures.length === 0 ? state("info", "state") : operation("error", "state", true),
    failures: ({ failures }) => failures,
    nodeIds: ({ nodeIds }) => nodeIds,
  }),
  GraphNodeCleanupFailed: metadata({
    classification: diagnostic("error", "state"),
    failures: ({ failures }) => failures,
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphNodeLiveDemandChanged: nodeEvent(state("debug", "live")),
  GraphNodeLiveFailed: metadata({
    classification: operation("error", "live", true),
    failures: ({ failures }) => failures,
    nodeIds: ({ nodeId }) => [nodeId],
  }),
  GraphNodeResultValidityChanged: nodeEvent(state("info", "state")),
} satisfies {
  readonly [TTag in RuntimeEventTag]: RuntimeEventMetadata<RuntimeEventOf<TTag>>;
};

function eventMetadata(event: RuntimeEvent): RuntimeEventMetadata<never> {
  return runtimeEventMetadata[event._tag] as RuntimeEventMetadata<never>;
}

function fixed<TEvent extends RuntimeEvent>(
  classification: RuntimeEventClassification
): RuntimeEventMetadata<TEvent> {
  return metadata({ classification });
}

function nodeEvent<TEvent extends RuntimeEvent & { readonly nodeId: NodeId }>(
  classification: RuntimeEventClassification
): RuntimeEventMetadata<TEvent> {
  return metadata({
    classification,
    nodeIds: ({ nodeId }) => [nodeId],
  });
}

function metadata<TEvent extends RuntimeEvent>(input: {
  readonly classification?: RuntimeEventClassification | undefined;
  readonly classify?: ((event: TEvent) => RuntimeEventClassification) | undefined;
  readonly failures?: ((event: TEvent) => ReadonlyArray<unknown>) | undefined;
  readonly nodeIds?: ((event: TEvent) => ReadonlyArray<NodeId>) | undefined;
}): RuntimeEventMetadata<TEvent> {
  const classify =
    input.classify ??
    (() => {
      if (input.classification === undefined) {
        throw new Error("Runtime event metadata must define classification.");
      }

      return input.classification;
    });

  return {
    classify,
    failures: input.failures ?? (() => []),
    nodeIds: input.nodeIds ?? (() => []),
  };
}

function lifecycle(
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline
): RuntimeEventClassification {
  return { category: "lifecycle", severity, reportable: false, timeline };
}

function command(
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline
): RuntimeEventClassification {
  return { category: "command", severity, reportable: false, timeline };
}

function input(
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline
): RuntimeEventClassification {
  return { category: "input", severity, reportable: false, timeline };
}

/**
 * Its own category rather than `input`, which is where publications used to sit.
 *
 * A signal is not something that arrived from outside the runtime, and filing it
 * under `input` cost a reader the only cheap way to ask for the message bus on
 * its own — the category then meant "an input, or a signal", so selecting either
 * one selected both. Subscriber failures stay `diagnostic`: they are a failure
 * first, and a feed of what is broken that omits them is the wrong trade.
 */
function signal(
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline
): RuntimeEventClassification {
  return { category: "signal", severity, reportable: false, timeline };
}

function state(
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline
): RuntimeEventClassification {
  return { category: "state", severity, reportable: false, timeline };
}

function operation(
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline,
  reportable = false
): RuntimeEventClassification {
  return { category: "operation", severity, reportable, timeline };
}

function diagnostic(
  severity: RuntimeEventSeverity,
  timeline: RuntimeEventTimeline
): RuntimeEventClassification {
  return { category: "diagnostic", severity, reportable: true, timeline };
}

function nodeStatusFailure(status: NodeStatus): unknown | undefined {
  return Match.value(status).pipe(
    Match.tag("Unwired", () => undefined),
    Match.tag("Invalid", ({ error }) => error),
    Match.tag("Wired", ({ run }) => nodeRunFailure(run)),
    Match.exhaustive
  );
}

function nodeRunFailure(
  status: Extract<NodeStatus, { readonly _tag: "Wired" }>["run"]
): unknown | undefined {
  return Match.value(status).pipe(
    Match.tag("Idle", () => undefined),
    Match.tag("Pending", () => undefined),
    Match.tag("Ready", () => undefined),
    Match.tag("Error", ({ error }) => error),
    Match.exhaustive
  );
}

function maybeFailure(failure: unknown | undefined): ReadonlyArray<unknown> {
  return failure === undefined ? [] : [failure];
}
