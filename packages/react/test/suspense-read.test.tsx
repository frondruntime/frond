import "./setup";
import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Component, type ReactNode, Suspense } from "react";
import { FrondReactAdapterInvariant } from "../src/errors";
import { type SuspenseRead, suspendPromise } from "../src/suspendPromise";
import { useReadyRead } from "../src/useReadyRead";

afterEach(cleanup);

class Boundary extends Component<
  { readonly children: ReactNode; readonly onError: (error: unknown) => void },
  { readonly error: unknown }
> {
  override state = { error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.error === undefined ? this.props.children : <output>failed</output>;
  }
}

test("a fulfilled read advances to the current attempt before returning ready state", async () => {
  const settled = suspendPromise(Promise.resolve());
  await settled;
  const next = Promise.withResolvers<void>();
  const pending = suspendPromise(next.promise);
  let current: SuspenseRead<string> = { _tag: "Pending", promise: settled };
  const read = (): SuspenseRead<string> => {
    const previous = current;
    if (previous._tag === "Pending" && previous.promise === settled) {
      current = { _tag: "Pending", promise: pending };
    }
    return previous;
  };
  function Reader() {
    return <output>{useReadyRead(read)}</output>;
  }
  const view = await act(async () =>
    render(
      <Suspense fallback="loading">
        <Reader />
      </Suspense>
    )
  );
  expect(view.container.textContent).toBe("loading");
  await act(async () => {
    current = { _tag: "Ready", value: "ready" };
    next.resolve();
  });
  expect(view.container.textContent).toBe("ready");
});

test("a fulfilled read cannot spin on the same attempt", async () => {
  const promise = suspendPromise(Promise.resolve());
  await promise;
  const read = (): SuspenseRead<string> => ({ _tag: "Pending", promise });
  let captured: unknown;
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  function Reader() {
    return <output>{useReadyRead(read)}</output>;
  }
  try {
    const view = await act(async () =>
      render(
        <Boundary
          onError={(error) => {
            captured = error;
          }}
        >
          <Reader />
        </Boundary>
      )
    );
    expect(view.container.textContent).toBe("failed");
    expect(captured).toBeInstanceOf(FrondReactAdapterInvariant);
  } finally {
    consoleError.mockRestore();
  }
});
