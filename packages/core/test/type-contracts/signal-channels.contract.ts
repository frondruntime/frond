import * as Frond from "@frondruntime/core";
import { Effect } from "effect";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

// An interface, deliberately: it is the declaration form an event map is written
// in, and the one a `Record<string, unknown>` constraint would reject.
interface CheckoutEvents {
  "checkout.started": { readonly cartId: string; readonly total: number };
  "checkout.completed": { readonly orderId: string };
  // biome-ignore lint/suspicious/noConfusingVoidType: an event that carries no payload is declared `void`.
  "app.opened": void;
}

const Checkout = Frond.Signals.defineChannel<CheckoutEvents>({
  name: "types/checkout",
  policy: { retention: "bounded", bufferSize: 256 },
});

// Registration is what a boot-time channel list needs, and it is what keeps a
// heterogeneously typed set of channels installable in one array.
Checkout satisfies Frond.Signals.RuntimeSignalChannelRegistration;
({ channels: [Checkout] }) satisfies Frond.Runtime.RuntimeOptions;

const untyped = Frond.Signals.defineChannel({
  name: "types/untyped",
  policy: { retention: "none" },
});
({ channels: [Checkout, untyped] }) satisfies Frond.Runtime.RuntimeOptions;

// Typed signals publish through the erased surface unchanged: `publish` takes a
// `RuntimeSignal`, and every member of the typed union is one.
Checkout.signal("checkout.started", {
  cartId: "c1",
  total: 12,
}) satisfies Frond.Signals.RuntimeSignal;
Checkout.signal("app.opened") satisfies Frond.Signals.RuntimeSignal;
Checkout.signal("app.opened", undefined, { correlationId: "r1" });

export type TypedSignalIsTheUnionOverNames = Expect<
  Equal<
    ReturnType<typeof Checkout.signal>["name"],
    "checkout.started" | "checkout.completed" | "app.opened"
  >
>;
export type TypedSubscriberErasesToThePlainSubscriber = Expect<
  Equal<ReturnType<typeof Checkout.subscriber>, Frond.Signals.RuntimeSignalSubscriber>
>;

// @ts-expect-error "checkout.abandoned" is not declared in CheckoutEvents.
Checkout.signal("checkout.abandoned", { cartId: "c1" });

// @ts-expect-error checkout.completed carries an orderId, not a cartId.
Checkout.signal("checkout.completed", { cartId: "c1" });

// @ts-expect-error checkout.started declares a payload, so it cannot be omitted.
Checkout.signal("checkout.started");

// @ts-expect-error app.opened carries nothing, so there is no payload to pass.
Checkout.signal("app.opened", { cartId: "c1" });

// The point of the union: one switch, a payload that is a different type in each
// branch, and no cast anywhere in the handler.
const narrowed: Array<string> = [];
Checkout.subscriber({
  name: "types/checkout-narrowing",
  handle: (record) =>
    Effect.sync(() => {
      switch (record.signal.name) {
        case "checkout.started": {
          narrowed.push(`${record.signal.payload.cartId}:${record.signal.payload.total}`);
          break;
        }
        case "checkout.completed": {
          narrowed.push(record.signal.payload.orderId);
          break;
        }
        case "app.opened": {
          narrowed.push("opened");
          break;
        }
      }
    }),
});

Checkout.subscriber({
  name: "types/checkout-payload-shapes",
  handle: (record) =>
    Effect.sync(() => {
      if (record.signal.name === "checkout.completed") {
        // @ts-expect-error the completed payload has an orderId and no cartId.
        narrowed.push(record.signal.payload.cartId);
      }
    }),
});

// An untyped channel keeps the surface it had: any name, an optional payload, and
// records that are the wide `RuntimeSignalRecord`.
untyped satisfies Frond.Signals.RuntimeSignalChannelDefinition;
untyped.signal("anything") satisfies Frond.Signals.RuntimeSignal;
untyped.signal("anything", { free: "form" }) satisfies Frond.Signals.RuntimeSignal;
untyped.signal("anything", { free: "form" }, { correlationId: "r1" });

export type UntypedChannelKeepsUnknownPayload = Expect<
  Equal<ReturnType<typeof untyped.signal>["payload"], unknown>
>;
export type UntypedChannelKeepsOpenNames = Expect<
  Equal<ReturnType<typeof untyped.signal>["name"], string>
>;
export type UntypedSubscriberSeesTheWideRecord = Expect<
  Equal<
    Parameters<Parameters<typeof untyped.subscriber>[0]["handle"]>[0],
    Frond.Signals.RuntimeSignalRecordOf<Record<string, unknown>>
  >
>;
