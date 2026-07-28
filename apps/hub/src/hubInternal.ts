import type { Runtime } from "@frondruntime/core";

/**
 * Tag prefix every node the hub runs for its own sake shares.
 *
 * A namespace rather than a list of tags on purpose. A list is a thing you
 * forget to extend: the next hub node would silently start feeding the loop
 * this prefix exists to break, and the symptom — a counter that climbs on an
 * idle machine — reads like a busy app rather than a bug.
 */
export const HUB_NODE_NAMESPACE = "hub/";

/**
 * Whether a record describes only the hub observing itself.
 *
 * The hub attaches to its own runtime, and applying an ingested batch runs an
 * action on `hub/attachments`, which emits its own events, which the same
 * attachment observes and ships in the next batch. Left alone that is
 * perpetual motion — measured at ~4 cycles a second, which is exactly the
 * flush interval, because the flush *is* the event source.
 *
 * Two cases are deliberately kept:
 *
 * - `nodeIds` empty. Runtime-level events (start, stop) belong to the runtime,
 *   not to any node, and dropping them would blind the hub to its own lifecycle.
 * - A record touching a hub node *and* something else. It carries signal about
 *   the something else, and a mixed record is not the hub talking to itself.
 */
export function isHubInternal(record: Runtime.RuntimeEventRecord): boolean {
  return (
    record.nodeIds.length > 0 &&
    record.nodeIds.every((nodeId) => nodeId.startsWith(HUB_NODE_NAMESPACE))
  );
}
