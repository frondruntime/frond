import { Match } from "effect";
import type { NodeId, NodeStatus } from "../graph";
import { runtimeEventNodeIds } from "../runtime/events";
import type { RuntimeEvent } from "../runtime/types";

export type RuntimeEventCategory =
  | "command"
  | "diagnostic"
  | "input"
  | "lifecycle"
  | "operation"
  | "state";

export type RuntimeEventSeverity = "debug" | "error" | "info" | "warning";

export type RuntimeEventTimeline = "live" | "state" | "system" | "work";

export interface RuntimeEventClassification {
  readonly category: RuntimeEventCategory;
  readonly severity: RuntimeEventSeverity;
  readonly reportable: boolean;
  readonly timeline: RuntimeEventTimeline;
}

export function classify(event: RuntimeEvent): RuntimeEventClassification {
  return classifyRuntimeEvent(event);
}

const classifyRuntimeEvent = Match.type<RuntimeEvent>().pipe(
  Match.tagsExhaustive({
    RuntimeStarted: () => lifecycle("info", "system"),
    RuntimeStopped: () => lifecycle("info", "state"),
    InputIngestionChanged: () => command("info", "system"),
    RuntimeInputReceived: () => input("info", "system"),
    RuntimeSignalPublished: () => input("info", "system"),
    RuntimeSignalSubscriberFailureObserved: () => diagnostic("error", "system"),
    RuntimeSinkFailureObserved: () => diagnostic("error", "system"),
    RuntimeObserverFailureObserved: () => diagnostic("error", "system"),
    GraphSystemStarted: () => lifecycle("info", "system"),
    GraphSystemStopped: () => lifecycle("info", "state"),
    GraphSystemInputObserved: () => input("debug", "system"),
    GraphNodeEnsured: ({ status }) =>
      nodeStatusFailure(status) === undefined
        ? command("debug", "state")
        : operation("error", "state", true),
    GraphNodeReadyEnsured: ({ status }) =>
      nodeStatusFailure(status) === undefined
        ? command("debug", "state")
        : operation("error", "state", true),
    GraphNodeChanged: () => state("debug", "state"),
    GraphActionStarted: () => operation("info", "work"),
    GraphActionSucceeded: () => operation("info", "work"),
    GraphActionFailed: () => operation("error", "work", true),
    GraphRefreshStarted: () => operation("info", "work"),
    GraphRefreshSucceeded: () => operation("info", "work"),
    GraphRefreshFailed: () => operation("error", "work", true),
    GraphNodeArgsUpdateStarted: () => operation("info", "work"),
    GraphNodeArgsUpdateSucceeded: () => operation("info", "work"),
    GraphNodeArgsUpdateFailed: () => operation("error", "work", true),
    GraphUnsafeNodeUpdated: () => operation("info", "work"),
    GraphUnsafeNodeUpdateFailed: () => operation("error", "work", true),
    GraphNodeReleased: ({ failure }) =>
      failure === undefined ? state("info", "state") : operation("error", "state", true),
    GraphNodesEvicted: ({ failures }) =>
      failures.length === 0 ? state("info", "state") : operation("error", "state", true),
    GraphNodeCleanupFailed: () => diagnostic("error", "state"),
    GraphNodeLiveDemandChanged: () => state("debug", "live"),
    GraphNodeLiveFailed: () => operation("error", "live", true),
    GraphNodeResultValidityChanged: () => state("info", "state"),
  })
);

export function failures(event: RuntimeEvent): ReadonlyArray<unknown> {
  return runtimeEventFailures(event);
}

const runtimeEventFailures = Match.type<RuntimeEvent>().pipe(
  Match.tagsExhaustive({
    RuntimeStarted: () => [],
    RuntimeStopped: () => [],
    InputIngestionChanged: () => [],
    RuntimeInputReceived: () => [],
    RuntimeSignalPublished: () => [],
    RuntimeSignalSubscriberFailureObserved: ({ cause }) => [cause],
    RuntimeSinkFailureObserved: ({ cause }) => [cause],
    RuntimeObserverFailureObserved: ({ cause }) => [cause],
    GraphSystemStarted: () => [],
    GraphSystemStopped: () => [],
    GraphSystemInputObserved: () => [],
    GraphNodeEnsured: ({ status }) => maybeFailure(nodeStatusFailure(status)),
    GraphNodeReadyEnsured: ({ status }) => maybeFailure(nodeStatusFailure(status)),
    GraphNodeChanged: () => [],
    GraphActionStarted: () => [],
    GraphActionSucceeded: () => [],
    GraphActionFailed: ({ error }) => [error],
    GraphRefreshStarted: () => [],
    GraphRefreshSucceeded: () => [],
    GraphRefreshFailed: ({ error }) => [error],
    GraphNodeArgsUpdateStarted: () => [],
    GraphNodeArgsUpdateSucceeded: () => [],
    GraphNodeArgsUpdateFailed: ({ error }) => [error],
    GraphUnsafeNodeUpdated: () => [],
    GraphUnsafeNodeUpdateFailed: ({ error }) => [error],
    GraphNodeReleased: ({ failure }) => (failure === undefined ? [] : [failure]),
    GraphNodesEvicted: ({ failures }) => failures,
    GraphNodeCleanupFailed: ({ failures }) => failures,
    GraphNodeLiveDemandChanged: () => [],
    GraphNodeLiveFailed: ({ failures }) => failures,
    GraphNodeResultValidityChanged: () => [],
  })
);

export function isReportable(event: RuntimeEvent): boolean {
  return classify(event).reportable;
}

export function nodeIds(event: RuntimeEvent): ReadonlyArray<NodeId> {
  return runtimeEventNodeIds(event);
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
