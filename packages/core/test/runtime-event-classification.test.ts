import { describe, expect, test } from "bun:test";
import { classify, failures, isReportable, nodeIds } from "../src/events";
import type { NodeId } from "../src/graph";
import type { RuntimeEvent } from "../src/runtime";
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
    expect(classify({ _tag: "GraphNodeChanged", nodeId, at })).toMatchObject({
      category: "state",
      reportable: false,
      severity: "debug",
      timeline: "state",
    });
    expect(
      classify({
        _tag: "GraphNodeLiveDemandChanged",
        nodeId,
        liveDemand: { isLive: true, sources: ["mobx"], scopes: [] },
        at,
      })
    ).toMatchObject({
      category: "state",
      reportable: false,
      timeline: "live",
    });
  });

  /**
   * A publication is its own category rather than an `input`, so a reader can
   * ask for the message bus without also getting everything that arrived from
   * outside the runtime. A subscriber failure is not part of that: it is a
   * failure, and it belongs in the feed of what is broken.
   */
  test("publishing a signal is a signal; failing to handle one is a diagnostic", () => {
    const signalRecord = {
      runtimeId: "runtime-events" as RuntimeEventSamplesRuntimeId,
      sequence: 1,
      recordedAt: at,
      signal: Signals.signal({ channel: "app.analytics", name: "checkout_started" }),
    };

    expect(classify({ _tag: "RuntimeSignalPublished", record: signalRecord, at })).toMatchObject({
      category: "signal",
      reportable: false,
      severity: "info",
      timeline: "system",
    });
    expect(
      classify({
        _tag: "RuntimeSignalSubscriberFailureObserved",
        subscriber: "audit-log",
        signal: signalRecord,
        cause: new Error("subscriber threw"),
        at,
      })
    ).toMatchObject({ category: "diagnostic", reportable: true, severity: "error" });
  });

  test("node id projection does not require event-specific devtools code", () => {
    expect(
      nodeIds({
        _tag: "GraphNodesEvicted",
        nodeIds: [nodeId, otherNodeId],
        reason: "test",
        failures: [],
        at,
      })
    ).toEqual([nodeId, otherNodeId]);
    expect(nodeIds({ _tag: "RuntimeStarted", at })).toEqual([]);
    expect(
      nodeIds({
        _tag: "GraphActionStarted",
        nodeId,
        action: "save",
        input: {},
        at,
      })
    ).toEqual([nodeId]);
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
    { _tag: "RuntimeStarted", at },
    { _tag: "RuntimeStopped", at, reason: "stop" },
    { _tag: "InputIngestionChanged", enabled: true, at },
    {
      _tag: "RuntimeInputReceived",
      input: { _tag: "RuntimeInput", name: "input", payload: {} },
      at,
    },
    { _tag: "RuntimeSignalPublished", record: signalRecord, at },
    {
      _tag: "RuntimeSignalSubscriberFailureObserved",
      subscriber: "subscriber",
      signal: signalRecord,
      cause: signalFailure,
      at,
    },
    {
      _tag: "RuntimeSinkFailureObserved",
      sink: "sink",
      eventTag: "RuntimeStarted",
      cause: sinkFailure,
      at,
    },
    {
      _tag: "RuntimeObserverFailureObserved",
      eventTag: "RuntimeStarted",
      cause: new Error("observer"),
      at,
    },
    { _tag: "GraphSystemStarted", at },
    { _tag: "GraphSystemStopped", at },
    { _tag: "GraphSystemInputObserved", inputTag: "RuntimeInput", at },
    {
      _tag: "GraphNodeEnsured",
      nodeId,
      status: { _tag: "Invalid", error: invalidGraphError },
      at,
    },
    {
      _tag: "GraphNodeReadyEnsured",
      nodeId,
      status: { _tag: "Wired", run: { _tag: "Ready" } },
      at,
    },
    {
      _tag: "GraphNodeReadyEnsured",
      nodeId,
      status: { _tag: "Invalid", error: invalidGraphError },
      at,
    },
    {
      _tag: "GraphNodeReadyEnsured",
      nodeId,
      status: { _tag: "Wired", run: { _tag: "Error", error: readinessError } },
      at,
    },
    { _tag: "GraphNodeChanged", nodeId, at },
    { _tag: "GraphActionStarted", nodeId, action: "save", input: {}, at },
    {
      _tag: "GraphActionSucceeded",
      nodeId,
      action: "save",
      input: {},
      value: "ok",
      at,
    },
    {
      _tag: "GraphActionFailed",
      nodeId,
      action: "save",
      input: {},
      error: actionFailure,
      at,
    },
    { _tag: "GraphRefreshStarted", nodeId, at },
    { _tag: "GraphRefreshSucceeded", nodeId, value: "ok", at },
    { _tag: "GraphRefreshFailed", nodeId, error: refreshFailure, at },
    { _tag: "GraphNodeArgsUpdateStarted", nodeId, at },
    { _tag: "GraphNodeArgsUpdateSucceeded", nodeId, shouldRefresh: false, at },
    { _tag: "GraphNodeArgsUpdateFailed", nodeId, error: argsFailure, at },
    { _tag: "GraphUnsafeNodeUpdated", nodeId, label: "debug", at },
    {
      _tag: "GraphUnsafeNodeUpdateFailed",
      nodeId,
      label: "debug",
      error: argsFailure,
      at,
    },
    {
      _tag: "GraphNodeReleased",
      nodeId,
      reason: "release",
      failure: cleanupFailure,
      at,
    },
    {
      _tag: "GraphNodesEvicted",
      nodeIds: [nodeId],
      reason: "evict",
      failures: [cleanupFailure],
      at,
    },
    {
      _tag: "GraphNodeCleanupFailed",
      nodeId,
      reason: "runtime-stop",
      failures: [cleanupFailure],
      at,
    },
    {
      _tag: "GraphNodeLiveDemandChanged",
      nodeId,
      liveDemand: { isLive: true, sources: ["manual"], scopes: [] },
      at,
    },
    { _tag: "GraphNodeLiveFailed", nodeId, failures: [cleanupFailure], at },
  ];
}

type RuntimeEventSamplesRuntimeId = import("../src/runtime").RuntimeId;
