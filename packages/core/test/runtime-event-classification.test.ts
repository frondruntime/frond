import { describe, expect, test } from "bun:test";
import { classify, failures, isReportable, nodeIds } from "../src/events";
import type { NodeId } from "../src/graph";
import { type RuntimeEvent, RuntimeEvents } from "../src/runtime";
import { Signals } from "../src/signals";
import {
  ActionFailed,
  DisposerFailed,
  Effect,
  EffectBoundaryFailed,
  RefreshFailed,
  UpdateNodeArgsFailed,
} from "./graphTestFixtures";

const nodeId = 'events/node:v1:"singleton"' as NodeId;
const otherNodeId = 'events/other:v1:"singleton"' as NodeId;
const at = 123;

describe("runtime event classification", () => {
  test("every runtime event variant has metadata", () => {
    const events = runtimeEventSamples();

    expect([...new Set(events.map((event) => event._tag))]).toEqual([
      "RuntimeStarted",
      "RuntimeStopped",
      "InputIngestionChanged",
      "RuntimeInputReceived",
      "RuntimeSignalPublished",
      "RuntimeSignalSubscriberFailureObserved",
      "RuntimeSinkFailureObserved",
      "RuntimeObserverFailureObserved",
      "GraphSystemStarted",
      "GraphSystemStopped",
      "GraphSystemInputObserved",
      "GraphNodeEnsured",
      "GraphNodeReadyEnsured",
      "GraphNodeChanged",
      "GraphActionStarted",
      "GraphActionSucceeded",
      "GraphActionFailed",
      "GraphRefreshStarted",
      "GraphRefreshSucceeded",
      "GraphRefreshFailed",
      "GraphNodeArgsUpdateStarted",
      "GraphNodeArgsUpdateSucceeded",
      "GraphNodeArgsUpdateFailed",
      "GraphUnsafeNodeUpdated",
      "GraphUnsafeNodeUpdateFailed",
      "GraphNodeReleased",
      "GraphNodesEvicted",
      "GraphNodeCleanupFailed",
      "GraphNodeLiveDemandChanged",
      "GraphNodeLiveFailed",
    ]);
    expect(events.map(classify)).toHaveLength(events.length);
  });

  test("failure-bearing events expose reportable failures", () => {
    const failureEvents = runtimeEventSamples().filter((event) => failures(event).length > 0);

    expect(failureEvents.map((event) => event._tag)).toEqual([
      "RuntimeSignalSubscriberFailureObserved",
      "RuntimeSinkFailureObserved",
      "RuntimeObserverFailureObserved",
      "GraphNodeEnsured",
      "GraphNodeReadyEnsured",
      "GraphNodeReadyEnsured",
      "GraphActionFailed",
      "GraphRefreshFailed",
      "GraphNodeArgsUpdateFailed",
      "GraphUnsafeNodeUpdateFailed",
      "GraphNodeReleased",
      "GraphNodesEvicted",
      "GraphNodeCleanupFailed",
      "GraphNodeLiveFailed",
    ]);
    expect(failureEvents.every(isReportable)).toBe(true);
  });

  test("state noise is not reportable", () => {
    expect(classify(RuntimeEvents.graphNodeChanged(nodeId, at))).toMatchObject({
      category: "state",
      reportable: false,
      severity: "debug",
      timeline: "state",
    });
    expect(
      classify(
        RuntimeEvents.graphNodeLiveDemandChanged(
          nodeId,
          { isLive: true, sources: ["mobx"], scopes: [] },
          at
        )
      )
    ).toMatchObject({
      category: "state",
      reportable: false,
      timeline: "live",
    });
  });

  test("node id projection does not require event-specific devtools code", () => {
    expect(nodeIds(RuntimeEvents.graphNodesEvicted([nodeId, otherNodeId], "test", [], at))).toEqual(
      [nodeId, otherNodeId]
    );
    expect(nodeIds(RuntimeEvents.runtimeStarted(at))).toEqual([]);
    expect(nodeIds(RuntimeEvents.graphActionStarted(nodeId, "save", {}, at))).toEqual([nodeId]);
  });
});

function runtimeEventSamples(): ReadonlyArray<RuntimeEvent> {
  const actionFailure = new ActionFailed({
    nodeId,
    tag: "events/node",
    action: "save",
    input: {},
    cause: new Error("action failed"),
  });
  const refreshFailure = new RefreshFailed({
    nodeId,
    tag: "events/node",
    cause: new Error("refresh failed"),
  });
  const argsFailure = new UpdateNodeArgsFailed({
    nodeId,
    tag: "events/node",
    cause: new Error("args failed"),
  });
  const cleanupFailure = new DisposerFailed({
    nodeId,
    tag: "events/node",
    cause: new Error("cleanup failed"),
  });
  const sinkFailure = new EffectBoundaryFailed({
    boundary: "runtime-sink",
    cause: new Error("sink failed"),
    effectCause: Effect.fail(new Error("sink failed")),
    pretty: "sink failed",
  });
  const signalFailure = new EffectBoundaryFailed({
    boundary: "runtime-signal-subscriber",
    cause: new Error("signal subscriber failed"),
    effectCause: Effect.fail(new Error("signal subscriber failed")),
    pretty: "signal subscriber failed",
  });
  const signalRecord = {
    runtimeId: "runtime-events" as RuntimeEventSamplesRuntimeId,
    sequence: 1,
    recordedAt: at,
    signal: Signals.signal({ channel: "app.analytics", name: "button_clicked" }),
  };
  const invalidGraphError = { _tag: "InvalidGraphForEventTest" };
  const readinessError = { _tag: "ReadinessErrorForEventTest" };

  return [
    RuntimeEvents.runtimeStarted(at),
    RuntimeEvents.runtimeStopped(at, "stop"),
    RuntimeEvents.inputIngestionChanged(true, at),
    RuntimeEvents.runtimeInputReceived({ _tag: "RuntimeInput", name: "input", payload: {} }, at),
    RuntimeEvents.runtimeSignalPublished(signalRecord, at),
    RuntimeEvents.runtimeSignalSubscriberFailureObserved(
      "subscriber",
      signalRecord,
      signalFailure,
      at
    ),
    RuntimeEvents.runtimeSinkFailureObserved("sink", "RuntimeStarted", sinkFailure, at),
    RuntimeEvents.runtimeObserverFailureObserved("RuntimeStarted", new Error("observer"), at),
    RuntimeEvents.graphSystemStarted(at),
    RuntimeEvents.graphSystemStopped(at),
    RuntimeEvents.graphSystemInputObserved("RuntimeInput", at),
    RuntimeEvents.graphNodeEnsured(nodeId, { _tag: "Invalid", error: invalidGraphError }, at),
    RuntimeEvents.graphNodeReadyEnsured(nodeId, { _tag: "Wired", run: { _tag: "Ready" } }, at),
    RuntimeEvents.graphNodeReadyEnsured(nodeId, { _tag: "Invalid", error: invalidGraphError }, at),
    RuntimeEvents.graphNodeReadyEnsured(
      nodeId,
      { _tag: "Wired", run: { _tag: "Error", error: readinessError } },
      at
    ),
    RuntimeEvents.graphNodeChanged(nodeId, at),
    RuntimeEvents.graphActionStarted(nodeId, "save", {}, at),
    RuntimeEvents.graphActionSucceeded(nodeId, "save", {}, "ok", at),
    RuntimeEvents.graphActionFailed(nodeId, "save", {}, actionFailure, at),
    RuntimeEvents.graphRefreshStarted(nodeId, at),
    RuntimeEvents.graphRefreshSucceeded(nodeId, "ok", at),
    RuntimeEvents.graphRefreshFailed(nodeId, refreshFailure, at),
    RuntimeEvents.graphNodeArgsUpdateStarted(nodeId, at),
    RuntimeEvents.graphNodeArgsUpdateSucceeded(nodeId, false, at),
    RuntimeEvents.graphNodeArgsUpdateFailed(nodeId, argsFailure, at),
    RuntimeEvents.graphUnsafeNodeUpdated(nodeId, "debug", at),
    RuntimeEvents.graphUnsafeNodeUpdateFailed(nodeId, "debug", argsFailure, at),
    RuntimeEvents.graphNodeReleased(nodeId, "release", at, cleanupFailure),
    RuntimeEvents.graphNodesEvicted([nodeId], "evict", [cleanupFailure], at),
    RuntimeEvents.graphNodeCleanupFailed(nodeId, "runtime-stop", [cleanupFailure], at),
    RuntimeEvents.graphNodeLiveDemandChanged(
      nodeId,
      { isLive: true, sources: ["manual"], scopes: [] },
      at
    ),
    RuntimeEvents.graphNodeLiveFailed(nodeId, [cleanupFailure], at),
  ];
}

type RuntimeEventSamplesRuntimeId = import("../src/runtime").RuntimeId;
