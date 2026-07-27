import { interruptedCancellation, type RuntimeCancellationReason } from "../../cancellation";
import type { LiveResourceStopReason } from "../types";

// Owner: the node-lifetime AbortController — one per ready-node incarnation.
// Created at acquire start so drivers can bind long-lived callbacks to
// `ctx.nodeSignal` immediately; ownership transfers to ready data at the
// acquire commit; aborted exactly once when the incarnation closes (teardown)
// or when the acquire settles without committing a ready node.

export interface AcquireNodeLifetime {
  /** The incarnation's signal, exposed to driver hooks as `ctx.nodeSignal`. */
  readonly signal: AbortSignal;
  /**
   * Hand off ownership to ready data at the acquire commit. After this the
   * committed node owns the controller and `abortIfUnowned` is a no-op —
   * teardown aborts it instead.
   */
  readonly handOff: () => AbortController;
  /**
   * Aborts the incarnation signal when the acquire settles without a ready
   * commit (failure, stale commit race, or interruption). No-op after a ready
   * hand-off and idempotent across settle paths.
   */
  readonly abortIfUnowned: () => void;
}

export function makeAcquireNodeLifetime(): AcquireNodeLifetime {
  const controller = new AbortController();
  let ownedByReady = false;

  return {
    signal: controller.signal,
    handOff: () => {
      ownedByReady = true;
      return controller;
    },
    abortIfUnowned: () => {
      if (!ownedByReady && !controller.signal.aborted) {
        controller.abort(interruptedCancellation("acquire settled without a ready node"));
      }
    },
  };
}

// Maps a teardown live-stop reason onto the cancellation vocabulary used by
// abort signals, so `ctx.nodeSignal.reason` explains which close path fired.
export function nodeCloseCancellation(reason: LiveResourceStopReason): RuntimeCancellationReason {
  switch (reason._tag) {
    case "NodeReleased":
      return { _tag: "Released", detail: "ready node closed" };
    case "NodeEvicted":
      return { _tag: "Evicted", detail: "ready node closed" };
    case "GraphStopped":
      return { _tag: "RuntimeStopped", detail: "ready node closed" };
    case "ReadyInvalidated":
      return { _tag: "ArgsSuperseded", detail: "ready node closed" };
    default:
      return { _tag: "Interrupted", detail: `ready node closed (${reason._tag})` };
  }
}
