import { describe, expect, test } from "bun:test";
import { Cause, Data } from "effect";
import { tag } from "../src";
import { createErrorReport, createRuntimeEventReports, projectError } from "../src/diagnostics";
import { classify, failures, nodeIds } from "../src/events";
import type { NodeId } from "../src/graph";
import { FrondRuntimeReadError, type RuntimeEvent, type RuntimeEventRecord } from "../src/runtime";
import { createFrondTestHarness } from "../src/testing";
import {
  AcquireFailed,
  ActionFailed,
  CycleDetected,
  type Dep,
  DependencyFailed,
  DependencyFailures,
  Driver,
  DriverOperationTimedOut,
  DriverPromiseFailed,
  dep,
  dependencies,
  Effect,
  GraphInvariantViolation,
  Key,
  KeyBuildFailed,
  KeyNonFiniteNumberError,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  serviceSpec,
} from "./graphTestFixtures";

// Node ids carry args; they must never reach the message or the fingerprint.
const nodeId = (tag: string) => `${tag}:v1:{"account":"0xabc123"}` as NodeId;

const walletTag = "brvx/reference/wallet";
const sessionTag = "brvx/reference/session";
const connectTag = "brvx/reference/connect";

class WalletInitializationFailure extends Data.TaggedError("WalletInitializationFailure")<{
  readonly cause: unknown;
}> {}

class HttpFailure extends Data.TaggedError("HttpFailure")<{ readonly status: number }> {}

class SwapRejected extends Data.TaggedError("SwapRejected")<{ readonly message: string }> {}

class QuoteFailed extends Data.TaggedError("QuoteFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class TimeoutException extends Data.TaggedError("TimeoutException")<Record<string, never>> {}

function walletAcquireFailure(inner: unknown): AcquireFailed {
  return new AcquireFailed({
    nodeId: nodeId(walletTag),
    tag: walletTag,
    cause: new DriverPromiseFailed({
      nodeId: nodeId(walletTag),
      tag: walletTag,
      operation: "acquire",
      cause: new WalletInitializationFailure({ cause: inner }),
    }),
  });
}

/** `ReadError(connect) > DependencyFailed(session→wallet) > <failure>` */
function readThroughSession(failure: unknown): FrondRuntimeReadError {
  return new FrondRuntimeReadError({
    message: "Frond node readiness failed.",
    nodeId: nodeId(connectTag),
    kind: "readiness",
    cause: new DependencyFailed({
      nodeId: nodeId(connectTag),
      tag: connectTag,
      dependency: "session",
      dependencyNodeId: nodeId(sessionTag),
      cause: new DependencyFailed({
        nodeId: nodeId(sessionTag),
        tag: sessionTag,
        dependency: "wallet",
        dependencyNodeId: nodeId(walletTag),
        cause: failure,
      }),
    }),
  });
}

function acquireFailure(tag: string, cause: unknown): AcquireFailed {
  return new AcquireFailed({ nodeId: nodeId(tag), tag, cause });
}

function expectNoNodeId(report: ReturnType<typeof createErrorReport>): void {
  expect(report.message).not.toContain("0xabc123");
  expect(report.fingerprint.join(" ")).not.toContain("0xabc123");
}

describe("error report worked examples (review §4)", () => {
  test("#1 app classification wraps an anonymous message carrier", () => {
    const failure = walletAcquireFailure(new Error("AppKit initialization exceeded 10000ms."));
    const report = createErrorReport(readThroughSession(failure));

    expect(report.error.name).toBe("FrondDiagnostic.WalletInitializationFailure");
    expect(report.message).toBe(
      "[brvx/reference/wallet acquire] AppKit initialization exceeded 10000ms."
    );
    expect(report.fingerprint).toEqual([
      "frond",
      "readiness",
      walletTag,
      "acquire",
      "WalletInitializationFailure",
    ]);
    expect(report.error.cause).toBe(failure);
    expect(report.contexts.frond).toMatchObject({
      failingNode: { id: nodeId(walletTag), tag: walletTag },
      requester: { id: nodeId(connectTag), tag: connectTag },
      path: [connectTag, sessionTag, walletTag],
      dependency: "wallet",
    });
    expect(report.tags).toMatchObject({
      "frond.kind": "readiness",
      "frond.retryable": "true",
      "frond.cause_type": "WalletInitializationFailure",
      "frond.failing_node": walletTag,
      "frond.operation": "acquire",
      "frond.requester": connectTag,
    });
    expectNoNodeId(report);
  });

  test("#2 an inner type shows in the message, not the fingerprint", () => {
    const first = createErrorReport(
      readThroughSession(walletAcquireFailure(new Error("AppKit initialization exceeded.")))
    );
    const second = createErrorReport(
      readThroughSession(walletAcquireFailure(new TypeError("Failed to fetch")))
    );

    expect(second.error.name).toBe("FrondDiagnostic.WalletInitializationFailure");
    expect(second.message).toBe("[brvx/reference/wallet acquire] TypeError: Failed to fetch");
    expect(second.contexts.frond).toMatchObject({ messageType: "TypeError" });
    expect(second.fingerprint).toEqual(first.fingerprint);
  });

  test("#3 an untagged JS bug in acquire is typed by its Error subclass", () => {
    const report = createErrorReport(
      acquireFailure(
        "brvx/reference/balances",
        new DriverPromiseFailed({
          nodeId: nodeId("brvx/reference/balances"),
          tag: "brvx/reference/balances",
          operation: "acquire",
          cause: new TypeError("Cannot read properties of undefined (reading 'amount')"),
        })
      )
    );

    expect(report.error.name).toBe("FrondDiagnostic.TypeError");
    expect(report.message).toBe(
      "[brvx/reference/balances acquire] Cannot read properties of undefined (reading 'amount')"
    );
    expect(report.fingerprint).toEqual([
      "frond",
      "readiness",
      "brvx/reference/balances",
      "acquire",
      "TypeError",
    ]);
  });

  test("#4 an unclassified action Error adds the masked message", () => {
    const report = createErrorReport(
      new ActionFailed({
        nodeId: nodeId("brvx/dex/quote"),
        tag: "brvx/dex/quote",
        action: "refreshQuote",
        input: { amount: 1 },
        cause: new Error("Quote 8f26-74e9 expired"),
      })
    );

    expect(report.error.name).toBe("FrondDiagnostic.Error");
    expect(report.message).toBe("[brvx/dex/quote refreshQuote] Quote 8f26-74e9 expired");
    expect(report.fingerprint).toEqual([
      "frond",
      "operation",
      "brvx/dex/quote",
      "refreshQuote",
      "Error",
      "Quote <hex> expired",
    ]);
    expectNoNodeId(report);
  });

  test("#5 the tryPromise carrier and its boilerplate are skipped", () => {
    const report = createErrorReport(
      acquireFailure(
        "brvx/reference/prices",
        new Cause.UnknownError(
          new TypeError("fetch failed"),
          "An error occurred in Effect.tryPromise"
        )
      )
    );

    expect(report.error.name).toBe("FrondDiagnostic.TypeError");
    expect(report.message).toBe("[brvx/reference/prices acquire] fetch failed");
  });

  test("#6 a tagged error without message reports only type and node", () => {
    const report = createErrorReport(
      acquireFailure("brvx/reference/rates", new HttpFailure({ status: 503 }))
    );

    expect(report.error.name).toBe("FrondDiagnostic.HttpFailure");
    expect(report.message).toBe("[brvx/reference/rates acquire]");
    expect(report.message).not.toContain("503");
  });

  test("#7 a domain action failure groups by its tag", () => {
    const report = createErrorReport(
      new ActionFailed({
        nodeId: nodeId("brvx/dex/swap"),
        tag: "brvx/dex/swap",
        action: "submit",
        input: {},
        cause: new SwapRejected({ message: "Slippage exceeded" }),
      })
    );

    expect(report.error.name).toBe("FrondDiagnostic.SwapRejected");
    expect(report.message).toBe("[brvx/dex/swap submit] Slippage exceeded");
    expect(report.fingerprint).toEqual([
      "frond",
      "operation",
      "brvx/dex/swap",
      "submit",
      "SwapRejected",
    ]);
  });

  test("#8 Frond as the cause uses its own generated message", () => {
    const report = createErrorReport(
      acquireFailure(
        walletTag,
        new DriverOperationTimedOut({
          nodeId: nodeId(walletTag),
          tag: walletTag,
          operation: "acquire",
          timeout: 10000,
          cancellation: { _tag: "TimedOut" },
        })
      )
    );

    expect(report.error.name).toBe("FrondDiagnostic.DriverOperationTimedOut");
    expect(report.message).toBe("[brvx/reference/wallet acquire] acquire timed out after 10000ms");
  });

  test("#9 a thrown string is ThrownString and adds the masked message", () => {
    const report = createErrorReport(acquireFailure("x", "boom"));

    expect(report.error.name).toBe("FrondDiagnostic.ThrownString");
    expect(report.message).toBe("[x acquire] boom");
    expect(report.fingerprint).toEqual([
      "frond",
      "readiness",
      "x",
      "acquire",
      "ThrownString",
      "boom",
    ]);
  });

  test("#10 the outermost app frame classifies, not a wrapped library tag", () => {
    const report = createErrorReport(
      acquireFailure(
        "brvx/dex/quote",
        new QuoteFailed({ message: "Quote service unavailable", cause: new TimeoutException() })
      )
    );

    expect(report.error.name).toBe("FrondDiagnostic.QuoteFailed");
    expect(report.message).toBe("[brvx/dex/quote acquire] Quote service unavailable");
  });

  test("#11 two failing dependencies give two source reports and none for the aggregate", () => {
    const wallet = walletAcquireFailure(new Error("AppKit initialization exceeded 10000ms."));
    const prices = acquireFailure(
      "brvx/reference/prices",
      new Cause.UnknownError(
        new TypeError("fetch failed"),
        "An error occurred in Effect.tryPromise"
      )
    );
    const aggregate = new DependencyFailures({
      nodeId: nodeId(sessionTag),
      tag: sessionTag,
      failures: [
        new DependencyFailed({
          nodeId: nodeId(sessionTag),
          tag: sessionTag,
          dependency: "wallet",
          dependencyNodeId: nodeId(walletTag),
          cause: wallet,
        }),
        new DependencyFailed({
          nodeId: nodeId(sessionTag),
          tag: sessionTag,
          dependency: "prices",
          dependencyNodeId: nodeId("brvx/reference/prices"),
          cause: prices,
        }),
      ],
    });
    const reports = [
      readinessFailedRecord(walletTag, wallet),
      readinessFailedRecord("brvx/reference/prices", prices),
      readinessFailedRecord(sessionTag, aggregate),
    ].flatMap(createRuntimeEventReports);

    expect(reports.map((report) => report.message)).toEqual([
      "[brvx/reference/wallet acquire] AppKit initialization exceeded 10000ms.",
      "[brvx/reference/prices acquire] fetch failed",
    ]);
  });

  test("#12 cycle, invariant, and key errors keep their Frond type", () => {
    const cycleFirst = 'diagnostics/cycle-first:v1:"singleton"' as NodeId;
    const cycle = createErrorReport(
      new CycleDetected({
        nodeId: cycleFirst,
        tag: "diagnostics/cycle-first",
        path: [cycleFirst, cycleFirst],
      })
    );
    const invariant = createErrorReport(
      new GraphInvariantViolation({
        nodeId: nodeId("diagnostics/invariant"),
        tag: "diagnostics/invariant",
        invariant: "ready dependency must expose graph-owned node object",
      })
    );
    const key = createErrorReport(
      new KeyBuildFailed({
        nodeId: "diagnostics/key:__invalid__:nan" as NodeId,
        tag: "diagnostics/key",
        cause: new KeyNonFiniteNumberError({
          _tag: "KeyNonFiniteNumberError",
          message: "Invalid key input at $.value: non-finite number.",
          path: "$.value",
          value: Number.NaN,
        }),
      })
    );

    expect(cycle.error.name).toBe("FrondDiagnostic.CycleDetected");
    expect(cycle.message).toBe("[diagnostics/cycle-first] Dependency cycle detected");
    expect(invariant.error.name).toBe("FrondDiagnostic.GraphInvariantViolation");
    expect(invariant.message).toBe(
      "[diagnostics/invariant] ready dependency must expose graph-owned node object"
    );
    expect(key.error.name).toBe("FrondDiagnostic.KeyNonFiniteNumberError");
    expect(key.message).toBe(
      "[diagnostics/key key] Invalid key input at $.value: non-finite number."
    );
  });

  test("one failure object resolves to one tracker error across surfaces", () => {
    const failure = walletAcquireFailure(new Error("AppKit initialization exceeded 10000ms."));
    const viaReader = createErrorReport(readThroughSession(failure));
    const viaSource = createRuntimeEventReports(readinessFailedRecord(walletTag, failure))[0];

    expect(viaSource?.error).toBe(viaReader.error);
    expect(createErrorReport(failure).error).toBe(viaReader.error);
  });
});

describe("error reports from the real graph (review §5)", () => {
  type LeafSpec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: string;
  }>;

  function failingLeaf(nodeTag: string, cause: unknown) {
    let attempts = 0;

    class FailingLeaf extends NodeBase<LeafSpec> {
      static readonly spec = serviceSpec.effect<LeafSpec>({
        tag: tag(nodeTag),
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.suspend(() => {
            attempts += 1;
            // Fail asynchronously so concurrent demand can join the attempt.
            return Effect.andThen(Effect.sleep("5 millis"), Effect.fail(cause));
          })
        ),
      });
    }

    return { FailingLeaf, attempts: () => attempts };
  }

  function reportsOf(events: ReadonlyArray<RuntimeEventRecord>) {
    return events.flatMap((record) =>
      createRuntimeEventReports(record).map((report) => ({ tag: record.event._tag, report }))
    );
  }

  // review §5: wallet fails under session; connect and header both read it.
  function spec5Graph() {
    const { FailingLeaf: WalletNode, attempts: walletAttempts } = failingLeaf(
      "spec5/wallet",
      new WalletInitializationFailure({ cause: new Error("AppKit initialization exceeded.") })
    );

    type SessionSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: { readonly wallet: Dep<typeof WalletNode> };
      readonly result: string;
    }>;

    class SessionNode extends NodeBase<SessionSpec> {
      static readonly spec = resourceSpec.effect<SessionSpec>({
        tag: tag("spec5/session"),
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ wallet: dep(WalletNode, {}) })),
        acquire: Driver.Acquire(() => Effect.succeed("session")),
      });
    }

    type ReaderSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: { readonly session: Dep<typeof SessionNode> };
      readonly result: string;
    }>;

    const reader = (readerTag: string) =>
      class ReaderNode extends NodeBase<ReaderSpec> {
        static readonly spec = resourceSpec.effect<ReaderSpec>({
          tag: tag(readerTag),
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({ session: dep(SessionNode, {}) })),
          acquire: Driver.Acquire(() => Effect.succeed(readerTag)),
        });
      };
    const ConnectNode = reader("spec5/connect");
    const HeaderNode = reader("spec5/header");

    return { WalletNode, ConnectNode, HeaderNode, walletAttempts };
  }

  test("§5: concurrent readers report only at the wallet, one fingerprint across surfaces", async () => {
    const { WalletNode, ConnectNode, HeaderNode, walletAttempts } = spec5Graph();
    const harness = createFrondTestHarness();
    await harness.start();
    const connect = harness.node(ConnectNode, {});
    const header = harness.node(HeaderNode, {});
    const wallet = harness.node(WalletNode, {});

    await Promise.all([
      connect.ensureReady().catch(() => undefined),
      header.ensureReady().catch(() => undefined),
    ]);
    await harness.waitForIdle();

    // Only the wallet reports; session and reader failures are
    // dependency-caused. The graph currently re-attempts the Errored session
    // for the second reader's still-open demand, so the wallet can fail (and
    // report) once per attempt, never once per reader.
    const reports = reportsOf(harness.events);
    expect(reports.map(({ tag }) => tag)).toEqual(
      Array.from({ length: walletAttempts() }, () => "GraphNodeReadinessFailed")
    );
    const sourceErrors = reports.map(({ report }) => report.error);
    const [source] = reports;
    expect(source?.report.message).toBe("[spec5/wallet acquire] AppKit initialization exceeded.");

    // Every surface resolves to a source's tracker error and the one
    // fingerprint; contexts stay per surface.
    const connectError = readError(() => connect.readReady());
    const headerError = readError(() => header.readReady());
    const walletError = harness.readError(wallet).error;
    for (const error of [connectError, headerError, walletError]) {
      const report = createErrorReport(error);
      expect(sourceErrors).toContain(report.error);
      expect(report.message).toBe(source?.report.message ?? "");
      expect(report.fingerprint).toEqual(source?.report.fingerprint ?? []);
    }
    expect(createErrorReport(connectError).contexts.frond).toMatchObject({
      requester: { tag: "spec5/connect" },
      path: ["spec5/connect", "spec5/session", "spec5/wallet"],
    });
    expect(createErrorReport(headerError).contexts.frond).toMatchObject({
      requester: { tag: "spec5/header" },
      path: ["spec5/header", "spec5/session", "spec5/wallet"],
    });

    await harness.teardown();
  });

  test("a later reader retries the Errored chain; each attempt reports at the wallet", async () => {
    const { WalletNode, ConnectNode, HeaderNode, walletAttempts } = spec5Graph();
    const harness = createFrondTestHarness();
    await harness.start();
    const connect = harness.node(ConnectNode, {});
    const header = harness.node(HeaderNode, {});
    const wallet = harness.node(WalletNode, {});

    await connect.ensureReady().catch(() => undefined);
    const connectError = readError(() => connect.readReady());
    // header's ensureReady retries the Errored chain: a second wallet attempt.
    await header.ensureReady().catch(() => undefined);
    const headerError = readError(() => header.readReady());
    // An ensure after a failed ensureReady observes the stored Error and
    // reports nothing new.
    const beforeEnsure = reportsOf(harness.events).length;
    await connect.ensure();
    await harness.waitForIdle();
    expect(reportsOf(harness.events)).toHaveLength(beforeEnsure);

    // Only the wallet reports, once per attempt; session, connect, and header
    // readiness failures are dependency-caused.
    const reports = reportsOf(harness.events);
    expect(walletAttempts()).toBe(2);
    expect(reports.map(({ tag }) => tag)).toEqual([
      "GraphNodeReadinessFailed",
      "GraphNodeReadinessFailed",
    ]);
    const [first, second] = reports;
    for (const source of [first, second]) {
      expect(source?.report.message).toBe("[spec5/wallet acquire] AppKit initialization exceeded.");
      expect(source?.report.error.name).toBe("FrondDiagnostic.WalletInitializationFailure");
      expect(source?.report.fingerprint).toEqual(first?.report.fingerprint ?? []);
    }

    // Each reader's error resolves to its attempt's source report: same object,
    // one fingerprint across surfaces, one tracker issue.
    const walletError = harness.readError(wallet).error;
    expect(createErrorReport(connectError).error).toBe(first?.report.error);
    expect(createErrorReport(headerError).error).toBe(second?.report.error);
    expect(createErrorReport(walletError).error).toBe(second?.report.error);
    for (const error of [connectError, headerError, walletError]) {
      expect(createErrorReport(error).fingerprint).toEqual(first?.report.fingerprint ?? []);
    }
    expect(projectError(connectError)).toMatchObject({
      failingNode: { tag: "spec5/wallet" },
      requester: { tag: "spec5/connect" },
      path: ["spec5/connect", "spec5/session", "spec5/wallet"],
    });

    await harness.teardown();
  });

  test("two failing dependencies give two reports", async () => {
    const { FailingLeaf: LeftNode } = failingLeaf("spec5/left", new TypeError("left failed"));
    const { FailingLeaf: RightNode } = failingLeaf("spec5/right", new RangeError("right failed"));

    type RootSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly left: Dep<typeof LeftNode>;
        readonly right: Dep<typeof RightNode>;
      };
      readonly result: string;
    }>;

    class RootNode extends NodeBase<RootSpec> {
      static readonly spec = resourceSpec.effect<RootSpec>({
        tag: tag("spec5/root"),
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ left: dep(LeftNode, {}), right: dep(RightNode, {}) })),
        acquire: Driver.Acquire(() => Effect.succeed("root")),
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();
    await harness
      .node(RootNode, {})
      .ensureReady()
      .catch(() => undefined);
    await harness.waitForIdle();

    const messages = reportsOf(harness.events)
      .map(({ report }) => report.message)
      .sort();

    expect(messages).toEqual([
      "[spec5/left acquire] left failed",
      "[spec5/right acquire] right failed",
    ]);

    await harness.teardown();
  });
});

function readError(read: () => unknown): unknown {
  try {
    read();
  } catch (cause) {
    return cause;
  }

  throw new Error("expected readReady to throw");
}

function readinessFailedRecord(tag: string, error: unknown): RuntimeEventRecord {
  const event: RuntimeEvent = {
    _tag: "GraphNodeReadinessFailed",
    nodeId: nodeId(tag),
    error,
    at: 100,
  };

  return {
    runtimeId: "runtime-test" as RuntimeEventRecord["runtimeId"],
    sequence: 1,
    recordedAt: 100,
    event,
    work: {
      runtimeId: "runtime-test" as RuntimeEventRecord["runtimeId"],
      workId: 1 as RuntimeEventRecord["work"]["workId"],
      source: "test",
      reason: "readiness",
      priority: "visible",
    },
    classification: classify(event),
    nodeIds: nodeIds(event),
    failures: failures(event),
  };
}
