// `./setup` is deliberately not imported: bun evaluates a shared module once and
// scopes its top-level `afterEach(cleanup)` to whichever file loaded it first, so
// importing it here would either steal that hook from another suite or leave this
// one without cleanup depending on file order. Registered inline instead, the way
// react-dom-read.test.tsx does.
import { afterEach, describe, expect, test } from "bun:test";
import "global-jsdom/register";
import { createRuntime, Signals } from "@frondruntime/core";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Effect } from "effect";
import { createElement, StrictMode, useState } from "react";
import { FrondProvider, usePublish } from "../src";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

interface CheckoutEvents {
  "checkout.started": { readonly cartId: string; readonly total: number };
  // biome-ignore lint/suspicious/noConfusingVoidType: an event that carries no payload is declared `void`.
  "app.opened": void;
}

const Checkout = Signals.defineChannel<CheckoutEvents>({
  name: "react/checkout",
  policy: { retention: "bounded", bufferSize: 8 },
});

describe("usePublish", () => {
  test("publishes declared events from a component and keeps one callback identity", async () => {
    const delivered: Array<string> = [];
    const identities = new Set<unknown>();

    const runtime = createRuntime({
      channels: [Checkout],
      signalSubscribers: [
        Checkout.subscriber({
          name: "react-checkout-probe",
          handle: (record) =>
            Effect.sync(() => {
              switch (record.signal.name) {
                case "checkout.started": {
                  delivered.push(`started:${record.signal.payload.cartId}`);
                  break;
                }
                case "app.opened": {
                  delivered.push("opened");
                  break;
                }
              }
            }),
        }),
      ],
    });

    function CheckoutButtons(): ReturnType<typeof createElement> {
      const publish = usePublish(Checkout);
      const [renders, setRenders] = useState(0);

      identities.add(publish);

      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            type: "button",
            onClick: () => void publish("checkout.started", { cartId: "cart-1", total: 12 }),
          },
          "start"
        ),
        createElement(
          "button",
          { type: "button", onClick: () => void publish("app.opened") },
          "open"
        ),
        // A re-render that changes nothing the publisher depends on, so a
        // publisher rebuilt per render would show up as a second identity.
        createElement(
          "button",
          { type: "button", onClick: () => setRenders(renders + 1) },
          `rerender:${renders}`
        )
      );
    }

    const view = render(
      createElement(
        StrictMode,
        null,
        createElement(FrondProvider, { runtime }, createElement(CheckoutButtons))
      )
    );

    await act(async () => {
      fireEvent.click(view.getByText("start"));
    });
    await act(async () => {
      fireEvent.click(view.getByText("open"));
    });

    expect(delivered).toEqual(["started:cart-1", "opened"]);

    await act(async () => {
      fireEvent.click(view.getByText("rerender:0"));
    });

    expect(view.getByText("rerender:1")).toBeTruthy();
    expect(identities.size).toBe(1);

    // The publisher writes to the same channel the retained buffer reads, so the
    // component's clicks are visible to anything reading history rather than
    // only to the live subscriber.
    const retained = await runtime.query({
      _tag: "RuntimeSignals",
      channel: Checkout.channel,
    });

    expect(
      retained._tag === "RuntimeSignals" ? retained.records.map((record) => record.signal.name) : []
    ).toEqual(["checkout.started", "app.opened"]);
  });
});
