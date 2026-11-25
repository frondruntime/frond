import type { NodeSpecArgs, NodeSpecLike } from "@frondruntime/core";
import { useRuntime } from "./context";
import { assertInsideObserver } from "./developmentChecks";
import type { ReadyReactNode } from "./types";
import { useReactNodeStore } from "./useReactNodeStore";
import { useReadyRead } from "./useReadyRead";

/**
 * Reads a ready Frond node for React rendering.
 *
 * Pending readiness suspends through React.use and readiness failures throw ErrorBoundary
 * errors. Only the ready path exposes the author node instance.
 *
 * Call it inside a MobX `observer` component. `node.result` is the committed
 * snapshot behind one observable reference, frozen with `development: true`: a
 * plain-data write rerenders every observer that read `node.result`. Unchanged
 * rows keep their object, so observer rows that take a row as a prop skip the
 * render. A share patch on MobX-observable models notifies only readers of
 * the changed observable fields. Non-observable non-plain values (plain classes,
 * Map, Set, Date) outside observable boundaries still make a share patch notify
 * every `node.result` reader.
 * Runtimes created with `development: true` throw
 * `FrondReactUsageError` on every call outside an observer.
 */
export function useNode<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): ReadyReactNode<TSpec> {
  const runtime = useRuntime();
  if (runtime.development) {
    assertInsideObserver("useNode", [spec]);
  }
  const store = useReactNodeStore(spec, args, "result");
  return useReadyRead(store.read).node as ReadyReactNode<TSpec>;
}
