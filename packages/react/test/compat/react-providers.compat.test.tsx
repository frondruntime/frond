import { afterEach, expect, spyOn, test } from "bun:test";
import "global-jsdom/register";
import {
  Driver,
  Key,
  NodeBase,
  type NodeSpec,
  Runtime,
  resourceSpec,
  Signals,
  tag,
} from "@frondruntime/core";
import { createFrondTestHarness, readySpec } from "@frondruntime/core/testing";
import {
  FrondProvider,
  FrondReactAdapterInvariant,
  FrondReactUsageError,
  getErrorRecovery,
  getErrorReport,
  isRecoverableNodeError,
  Preload,
  useNode,
  useNodes,
  usePublish,
  useRuntime,
  useRuntimeClient,
} from "@frondruntime/react";
import { TestFrondProvider } from "@frondruntime/react/testing";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Effect } from "effect";
import { Component, type ReactNode, StrictMode, Suspense, useState } from "react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const harnesses: Array<ReturnType<typeof createFrondTestHarness>> = [];

afterEach(async () => {
  cleanup();
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

async function startHarness(options: Parameters<typeof createFrondTestHarness>[0] = {}) {
  const harness = createFrondTestHarness(options);
  harnesses.push(harness);
  await harness.start();
  return harness;
}

type BoundaryProps = {
  readonly children: ReactNode;
  readonly fallback: (error: unknown, reset: () => void) => ReactNode;
};

class Boundary extends Component<BoundaryProps, { readonly error: unknown }> {
  override state = { error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error === undefined
      ? this.props.children
      : this.props.fallback(this.state.error, () => this.setState({ error: undefined }));
  }
}

type TextSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: string;
}>;

test("a boot failure reaches the boundary with a report and recovers through explicit retry", async () => {
  const boot = Promise.withResolvers<string>();
  let recover = false;
  let captured: unknown;
  let pending: Promise<unknown> = Promise.resolve();
  class RecoverableNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/recoverable-boot"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => (recover ? "recovered content" : boot.promise)),
    });
  }
  function Content() {
    return <output>{useNode(RecoverableNode, {}).result}</output>;
  }
  const harness = await startHarness();
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const view = render(
      <FrondProvider runtime={harness.runtime}>
        <Boundary
          fallback={(error, reset) => {
            captured = error;
            const report = getErrorReport(error);
            const recovery = getErrorRecovery(error);
            return (
              <>
                <output>
                  {report.kind}:{report.causeType}:{report.causeMessage}:
                  {String(isRecoverableNodeError(error))}
                </output>
                <button
                  type="button"
                  onClick={() => {
                    if (recovery === undefined) throw new Error("Missing readiness recovery");
                    pending = recovery.retry().then(reset);
                  }}
                >
                  retry
                </button>
              </>
            );
          }}
        >
          <Suspense fallback={<output>booting</output>}>
            <Content />
          </Suspense>
        </Boundary>
      </FrondProvider>
    );
    expect(view.getByText("booting")).toBeTruthy();
    await act(async () => boot.reject(new Error("backend unavailable")));
    expect(await view.findByText("readiness:Error:backend unavailable:true")).toBeTruthy();
    expect(captured).toBeInstanceOf(Runtime.FrondRuntimeReadError);
    const nodeId = harness.node(RecoverableNode, {}).nodeId;
    expect(captured).toMatchObject({
      _tag: "FrondRuntimeReadError",
      kind: "readiness",
      retryable: true,
      nodeId,
      cause: { _tag: "AcquireFailed", tag: "compat/react/recoverable-boot", nodeId },
    });
    expect(getErrorReport(captured)).toMatchObject({
      kind: "readiness",
      retryable: true,
      causeType: "Error",
      causeMessage: "backend unavailable",
      failingNode: { id: nodeId, tag: "compat/react/recoverable-boot" },
      rootTag: "Error",
      rootMessage: "backend unavailable",
      nodeId,
      nodeTag: "compat/react/recoverable-boot",
    });
    expect(getErrorRecovery(captured)).toMatchObject({
      _tag: "FrondReactErrorRecovery",
      nodeId,
      reason: "readiness",
      retryable: true,
    });
    expect(typeof getErrorRecovery(captured)?.resetKey).toBe("string");
    expect(typeof getErrorRecovery(captured)?.retry).toBe("function");
    recover = true;
    await act(async () => {
      fireEvent.click(view.getByText("retry"));
      await pending;
    });
    expect(await view.findByText("recovered content")).toBeTruthy();
  } finally {
    consoleError.mockRestore();
  }
});

test("useNodes sends a failed sibling boot to the boundary without exposing a partial map", async () => {
  const failure = Promise.withResolvers<string>();
  class ReadyNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/composite-ready"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "ready sibling"),
    });
  }
  class FailedNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/composite-failure"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => failure.promise),
    });
  }
  function Content() {
    const nodes = useNodes({ ready: [ReadyNode, {}], failed: [FailedNode, {}] });
    return (
      <output>
        {nodes.ready.result}/{nodes.failed.result}
      </output>
    );
  }
  const harness = await startHarness();
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const view = render(
      <FrondProvider runtime={harness.runtime}>
        <Boundary
          fallback={(error) => (
            <output>
              {getErrorReport(error).failingNode?.tag}:{String(isRecoverableNodeError(error))}
            </output>
          )}
        >
          <Suspense fallback={<output>booting together</output>}>
            <Content />
          </Suspense>
        </Boundary>
      </FrondProvider>
    );
    expect(view.getByText("booting together")).toBeTruthy();
    expect(view.queryByText("ready sibling")).toBeNull();
    await act(async () => failure.reject(new Error("sibling failed")));
    expect(await view.findByText("compat/react/composite-failure:true")).toBeTruthy();
    expect(view.queryByText(/ready sibling/)).toBeNull();
  } finally {
    consoleError.mockRestore();
  }
});

test("a hook outside FrondProvider exposes a typed usage error to the boundary", () => {
  let captured: unknown;
  function Content() {
    useRuntime();
    return <output>unexpected content</output>;
  }
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const view = render(
      <Boundary
        fallback={(error) => {
          captured = error;
          return (
            <output>
              {error instanceof FrondReactUsageError
                ? `${error._tag}:${error.hook}`
                : "unexpected error"}
            </output>
          );
        }}
      >
        <Content />
      </Boundary>
    );
    expect(view.getByText("FrondReactUsageError:useRuntime")).toBeTruthy();
    expect(captured).toBeInstanceOf(FrondReactUsageError);
    expect(getErrorRecovery(captured)).toBeUndefined();
    expect(isRecoverableNodeError(captured)).toBe(false);
  } finally {
    consoleError.mockRestore();
  }
});

test.each([
  FrondReactUsageError,
  FrondReactAdapterInvariant,
])("%p preserves the public error fields and does not offer readiness recovery", (ErrorType) => {
  const cause = new Error("adapter cause");
  const error = new ErrorType({ hook: "useNode", message: "adapter message", cause });
  const view = render(
    <output>
      {error._tag}:{error.hook}:{error.message}
    </output>
  );
  expect(view.getByText(`${ErrorType.name}:useNode:adapter message`)).toBeTruthy();
  expect(error.name).toBe(ErrorType.name);
  expect(error.cause).toBe(cause);
  expect(getErrorRecovery(error)).toBeUndefined();
  expect(isRecoverableNodeError(error)).toBe(false);
});

test("Preload boots siblings together and waits for each layer before displaying children", async () => {
  const first = Promise.withResolvers<string>();
  const sibling = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const firstEntered = Promise.withResolvers<void>();
  const siblingEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const started = new Set<string>();
  class FirstNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/preload-first"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => {
        started.add("first");
        firstEntered.resolve();
        return first.promise;
      }),
    });
  }
  class SiblingNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/preload-sibling"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => {
        started.add("sibling");
        siblingEntered.resolve();
        return sibling.promise;
      }),
    });
  }
  class SecondNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/preload-second"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => {
        started.add("second");
        secondEntered.resolve();
        return second.promise;
      }),
    });
  }
  function Content() {
    const nodes = useNodes({
      first: [FirstNode, {}],
      sibling: [SiblingNode, {}],
      second: [SecondNode, {}],
    });
    return (
      <output>
        {nodes.first.result}/{nodes.sibling.result}/{nodes.second.result}
      </output>
    );
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback={<output>preloading</output>}>
        <Preload
          nodes={[
            { first: [FirstNode, {}], sibling: [SiblingNode, {}] },
            { second: [SecondNode, {}] },
          ]}
        >
          <Content />
        </Preload>
      </Suspense>
    </FrondProvider>
  );
  await act(async () => {
    await Promise.all([firstEntered.promise, siblingEntered.promise]);
  });
  expect(started).toEqual(new Set(["first", "sibling"]));
  expect(view.getByText("preloading")).toBeTruthy();
  await act(async () => first.resolve("first"));
  expect(started).toEqual(new Set(["first", "sibling"]));
  expect(view.getByText("preloading")).toBeTruthy();
  await act(async () => sibling.resolve("sibling"));
  await secondEntered.promise;
  expect(view.getByText("preloading")).toBeTruthy();
  await act(async () => second.resolve("second"));
  expect(await view.findByText("first/sibling/second")).toBeTruthy();
});

test("an empty Preload displays children immediately", async () => {
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Preload nodes={[]}>
        <output>immediate children</output>
      </Preload>
    </FrondProvider>
  );
  expect(view.getByText("immediate children")).toBeTruthy();
});

test.each([
  "harness",
  "runtime",
] as const)("TestFrondProvider uses the supplied %s and leaves it usable after unmount", async (source) => {
  class ProvidedNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag(`compat/react/test-provider-${source}`),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "production value"),
    });
  }
  const harness = await startHarness({
    specOverrides: [{ from: ProvidedNode, to: readySpec(ProvidedNode, "test value") }],
  });
  function Content() {
    const runtime = useRuntime();
    const client = useRuntimeClient();
    const same = runtime === harness.runtime && client === harness.client;
    return (
      <output>
        {String(same)}:{useNode(ProvidedNode, {}).result}
      </output>
    );
  }
  const children = (
    <Suspense fallback="booting">
      <Content />
    </Suspense>
  );
  const view = render(
    source === "harness" ? (
      <TestFrondProvider harness={harness}>{children}</TestFrondProvider>
    ) : (
      <TestFrondProvider runtime={harness.runtime}>{children}</TestFrondProvider>
    )
  );
  expect(await view.findByText("true:test value")).toBeTruthy();
  view.unmount();
  expect((await harness.node(ProvidedNode, {}).ensureReadyNode()).result).toBe("test value");
});

test("TestFrondProvider owns an isolated runtime through StrictMode and stops it on unmount", async () => {
  class OwnedNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/owned-provider"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "production value"),
    });
  }
  const stopped = Promise.withResolvers<void>();
  let ownedRuntime: Runtime.Runtime | undefined;
  function Content() {
    ownedRuntime = useRuntime();
    return <output>{useNode(OwnedNode, {}).result}</output>;
  }
  const view = render(
    <StrictMode>
      <TestFrondProvider
        options={{
          specOverrides: [{ from: OwnedNode, to: readySpec(OwnedNode, "isolated value") }],
          sinks: [
            {
              name: "compat-owned-stop",
              handle: (record) =>
                Effect.sync(() => {
                  if (record.event._tag === "RuntimeStopped") stopped.resolve();
                }),
            },
          ],
        }}
      >
        <Suspense fallback="booting">
          <Content />
        </Suspense>
      </TestFrondProvider>
    </StrictMode>
  );
  expect(await view.findByText("isolated value")).toBeTruthy();
  view.unmount();
  await stopped.promise;
  if (ownedRuntime === undefined) throw new Error("The provider did not supply its runtime");
  const outcome = await ownedRuntime.client
    .node(OwnedNode, {})
    .ensureReady()
    .then(
      () => "unexpected success",
      (error: unknown) => error
    );
  expect(outcome).toMatchObject({ _tag: "FrondRuntimeClosed" });
});

test("usePublish and context hooks follow the provider runtime when it changes", async () => {
  const channel = Signals.defineChannel<{ readonly clicked: { readonly screen: string } }>({
    name: "compat/react/clicks",
    policy: { retention: "bounded", bufferSize: 4 },
  });
  const firstDelivered: string[] = [];
  const secondDelivered: string[] = [];
  const makeHarness = (delivered: string[]) =>
    startHarness({
      channels: [channel],
      signalSubscribers: [
        channel.subscriber({
          name: "compat-clicks",
          handle: (record) =>
            Effect.sync(() => {
              delivered.push(record.signal.payload.screen);
            }),
        }),
      ],
    });
  const first = await makeHarness(firstDelivered);
  const second = await makeHarness(secondDelivered);
  let pending: Promise<void> = Promise.resolve();
  function Content({
    screen,
    expected,
  }: {
    readonly screen: string;
    readonly expected: typeof first;
  }) {
    const runtime = useRuntime();
    const client = useRuntimeClient();
    const publish = usePublish(channel);
    const [status, setStatus] = useState("idle");
    return (
      <>
        <output>
          {screen}:{String(runtime === expected.runtime && client === expected.client)}:{status}
        </output>
        <button
          type="button"
          onClick={() => {
            pending = publish("clicked", { screen }).then(() => setStatus(`delivered ${screen}`));
          }}
        >
          publish
        </button>
      </>
    );
  }
  const view = render(
    <FrondProvider runtime={first.runtime}>
      <Content screen="first" expected={first} />
    </FrondProvider>
  );
  expect(view.getByText("first:true:idle")).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByText("publish"));
    await pending;
  });
  expect(view.getByText("first:true:delivered first")).toBeTruthy();
  view.rerender(
    <FrondProvider runtime={second.runtime}>
      <Content screen="second" expected={second} />
    </FrondProvider>
  );
  await act(async () => {
    fireEvent.click(view.getByText("publish"));
    await pending;
  });
  expect(view.getByText("second:true:delivered second")).toBeTruthy();
  expect(firstDelivered).toEqual(["first"]);
  expect(secondDelivered).toEqual(["second"]);
});
