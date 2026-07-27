// Public core types are imported from the package name so the emitted testing
// declaration rollup references `@frondruntime/core` instead of duplicating
// the main entry's types.
import type * as Frond from "@frondruntime/core";
import { Effect } from "effect";

/**
 * The Promise-facade surface `effectHostFromRuntime` re-bridges. A `Pick` so
 * tests can hand in a wrapped facade (counting `observe`, rejecting `submit`,
 * forbidden snapshots) without carrying the full `Runtime` shape.
 */
export type EffectHostRuntime = Pick<
  Frond.Runtime.Runtime,
  | "resolveNodeIdSync"
  | "getStatusSync"
  | "readNodeSnapshotSync"
  | "readNodeRevisionSync"
  | "readNodeSnapshot"
  | "submit"
  | "observe"
>;

/**
 * The default Effect runner for `createRuntimeClient` in tests: plain
 * `runPromise`/`runSync` with no instrumentation.
 */
export const effectBridgeRunner: Frond.Runtime.RuntimeEffectBridgeRunner = {
  run: (effect) => Effect.runPromise(effect),
  runSync: (effect) => Effect.runSync(effect),
};

/**
 * Bridges a Promise-facade runtime back into the Effect-native host shape
 * `createRuntimeClient` expects.
 *
 * Tests wrap the Promise facade (count subscriptions, reject specific
 * submits, forbid snapshots) and then need a client rebuilt over the wrapped
 * facade; this is the one typed re-bridge for that, so hand-rolled host
 * literals with `as never` casts are never needed.
 */
export function effectHostFromRuntime(runtime: EffectHostRuntime): Frond.Runtime.RuntimeClientHost {
  return {
    resolveNodeIdSync: runtime.resolveNodeIdSync,
    getStatusSync: runtime.getStatusSync,
    readNodeSnapshotSync: runtime.readNodeSnapshotSync,
    readNodeRevisionSync: runtime.readNodeRevisionSync,
    readNodeSnapshot: (nodeId) => Effect.promise(() => runtime.readNodeSnapshot(nodeId)),
    submit: (command) =>
      Effect.tryPromise({
        try: () => runtime.submit(command),
        // The facade rejects with the runtime's own typed error; the cast only
        // restores the type the Promise channel erased.
        catch: (error) => error as Frond.Runtime.RuntimeError,
      }),
    observe: (observer) => Effect.sync(() => runtime.observe(observer)),
  };
}
