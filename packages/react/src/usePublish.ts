import type * as Frond from "@frondruntime/core";
import { useCallback } from "react";
import { useRuntime } from "./context";

/**
 * A channel-bound publisher: the names its channel declares, and each one's
 * payload.
 *
 * Generic at the call rather than at the hook, so one publisher covers every
 * event on the channel and each call narrows to the one it names.
 */
export type FrondPublish<TEvents extends Frond.Signals.SignalEventMap> = <
  K extends keyof TEvents & string,
>(
  name: K,
  ...args: Frond.Signals.SignalPayloadArgs<TEvents[K]>
) => Promise<void>;

/**
 * Publishes to one signal channel from a component.
 *
 * ```tsx
 * const publish = FrondReact.usePublish(Checkout);
 *
 * <button onClick={() => void publish("checkout.started", { cartId, total })} />
 * ```
 *
 * Bound to a channel rather than returning `runtime.publish`, because the point
 * is the typing: the channel carries its event map, so the call site gets the
 * declared names with the payload each one declares instead of a `RuntimeSignal`
 * it has to assemble correctly. `useRuntime` plus `Checkout.signal(...)` is the
 * same two operations and stays available; this is the shorter spelling of the
 * common one.
 *
 * Stable while the runtime and the channel are, which is the usual case — a
 * channel is a module constant — so it can be a dependency of other hooks
 * without re-subscribing anything.
 *
 * `void` on the returned Promise is deliberate at the call site above rather
 * than sloppy. Awaiting it is meaningful — publish resolves once every
 * subscriber has run — and a failing subscriber is not what would reject: that
 * is reported as a `RuntimeSignalSubscriberFailureObserved` runtime event, not
 * to the publisher, so an unhandled rejection is never what a failed handler
 * looks like.
 *
 * One thing does reject, and `void` does not cover it. Publishing to a stopped
 * runtime fails with `FrondRuntimeClosed`, because publish is admitted as
 * runtime work like anything else. The window is real rather than theoretical:
 * `createRuntimeCoordinator` stops the outgoing runtime on an HMR swap or a test
 * teardown, and this callback holds that runtime until React re-renders, so a
 * click in between rejects. Where that window is reachable — a component that
 * survives a swap, an app whose teardown is not the end of the process — catch
 * it rather than voiding it:
 *
 * ```tsx
 * onClick={() => {
 *   publish("checkout.started", { cartId, total }).catch(() => {});
 * }}
 * ```
 */
export function usePublish<TEvents extends Frond.Signals.SignalEventMap = Record<string, unknown>>(
  channel: Frond.Signals.RuntimeSignalChannelDefinition<TEvents>
): FrondPublish<TEvents> {
  const runtime = useRuntime();

  return useCallback<FrondPublish<TEvents>>(
    (name, ...args) => runtime.publish(channel.signal(name, ...args)),
    [runtime, channel]
  );
}
