import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type ActionContract,
  type Dep,
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  resultCommit,
  serviceSpec,
  tag,
  unwrapEffect,
} from "../src";
import {
  createErrorReport,
  createRuntimeReportSink,
  type FrondErrorReport,
} from "../src/diagnostics";
import { createRuntime, type RuntimeSink } from "../src/runtime";

function collectReports(): {
  readonly reports: Array<FrondErrorReport>;
  readonly sink: RuntimeSink;
} {
  const reports: Array<FrondErrorReport> = [];

  return {
    reports,
    sink: createRuntimeReportSink({
      name: "coverage-report-sink",
      handleReport: ({ report }) => {
        reports.push(report);
      },
    }),
  };
}

type FailingAcquireSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: number;
  readonly actions: { readonly touch: ActionContract<void> };
}>;

class FailingAcquireNode extends NodeBase<FailingAcquireSpec> {
  static readonly spec = serviceSpec.async<FailingAcquireSpec>({
    tag: tag("tests/coverage-failing-acquire"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => {
      throw new Error("acquire exploded");
    }),
    actions: {
      touch: Driver.Action(() => undefined),
    },
  });
}

type InvalidKeySpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: number;
}>;

class InvalidKeyNode extends NodeBase<InvalidKeySpec> {
  static readonly spec = serviceSpec.async<InvalidKeySpec>({
    tag: tag("tests/coverage-invalid-key"),
    key: () => {
      throw new Error("key exploded");
    },
    acquire: Driver.Acquire(() => 1),
  });
}

type InvalidKeyParentSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: { readonly child: Dep<typeof InvalidKeyNode> };
  readonly result: number;
}>;

class InvalidKeyParentNode extends NodeBase<InvalidKeyParentSpec> {
  static readonly spec = serviceSpec.async<InvalidKeyParentSpec>({
    tag: tag("tests/coverage-invalid-key-parent"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ child: dep(InvalidKeyNode, {}) })),
    acquire: Driver.Acquire(() => 2),
  });
}

type ExpiringSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: number };
}>;

/** Expires soon after loading; the first acquire succeeds, later ones may fail. */
function expiringNode(name: string, reacquire: "succeeds" | "fails") {
  return class ExpiringNode extends NodeBase<ExpiringSpec> {
    static readonly spec = resourceSpec.effect<ExpiringSpec>({
      tag: tag(`tests/coverage-expiring-${name}`),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      resultValidity: { _tag: "TimeBound", expireAfter: "200 millis" },
      acquire: Driver.Acquire(() => {
        const acquires = (acquiresByName[name] ?? 0) + 1;
        acquiresByName[name] = acquires;

        return acquires > 1 && reacquire === "fails"
          ? Effect.fail(new Error(`${name} re-acquire exploded`))
          : Effect.succeed(resultCommit({ value: acquires }, { loadedAt: Date.now() }));
      }),
    });
  };
}

let acquiresByName: Record<string, number> = {};

const ExpiringWalletNode = expiringNode("wallet", "fails");
const ExpiringQuoteNode = expiringNode("quote", "succeeds");

type DependentSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly wallet: Dep<typeof ExpiringWalletNode>;
    readonly quote: Dep<typeof ExpiringQuoteNode>;
  };
  readonly result: number;
  readonly actions: { readonly save: ActionContract<void> };
}>;

class DependentNode extends NodeBase<DependentSpec> {
  static readonly spec = serviceSpec.async<DependentSpec>({
    tag: tag("tests/coverage-dependent"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      wallet: dep(ExpiringWalletNode, {}),
      quote: dep(ExpiringQuoteNode, {}),
    })),
    acquire: Driver.Acquire(() => 3),
    actions: {
      save: Driver.Action(() => undefined),
    },
  });
}

const expiry = () => new Promise((resolve) => setTimeout(resolve, 250));

describe("report coverage: one failure, exactly one report", () => {
  beforeEach(() => {
    acquiresByName = {};
  });

  test("an action on a fresh node whose implicit acquire fails reports only the acquire", async () => {
    const { reports, sink } = collectReports();
    const runtime = createRuntime({ sinks: [sink] });
    const node = runtime.client.node(FailingAcquireNode, {});

    const result = await unwrapEffect(node.action("touch", undefined));

    expect(result._tag).toBe("Failure");
    await runtime.query({ _tag: "RuntimeEvents" });
    expect(reports.map((report) => report.message)).toEqual([
      "[tests/coverage-failing-acquire acquire] acquire exploded",
    ]);
    // Reporting the action's own rejection resolves to the same failure.
    if (result._tag === "Failure") {
      expect(createErrorReport(result.error).error).toBe(reports[0]?.error);
    }
  });

  test("an action on a ready node whose dependency re-failed reports only the dependency", async () => {
    const { reports, sink } = collectReports();
    const runtime = createRuntime({ sinks: [sink] });
    const dependent = runtime.client.node(DependentNode, {});
    const wallet = runtime.client.node(ExpiringWalletNode, {});
    const quote = runtime.client.node(ExpiringQuoteNode, {});

    await dependent.ensureReady();
    await expiry();
    await wallet.ensureReady().catch(() => undefined);
    await quote.ensureReady();
    const result = await unwrapEffect(dependent.action("save", undefined));

    expect(result._tag).toBe("Failure");
    expect(wallet.read()._tag).toBe("Error");
    await runtime.query({ _tag: "RuntimeEvents" });
    expect(reports.map((report) => report.message)).toEqual([
      "[tests/coverage-expiring-wallet acquire] wallet re-acquire exploded",
    ]);
    if (result._tag === "Failure") {
      expect(createErrorReport(result.error).error).toBe(reports[0]?.error);
    }
  });

  test("an action observing one reported and one unreported dependency reports the latter once", async () => {
    const { reports, sink } = collectReports();
    const runtime = createRuntime({ sinks: [sink] });
    const dependent = runtime.client.node(DependentNode, {});
    const wallet = runtime.client.node(ExpiringWalletNode, {});

    await dependent.ensureReady();
    await expiry();
    // The wallet's attempt reports its failure; the quote merely expired.
    await wallet.ensureReady().catch(() => undefined);
    const result = await unwrapEffect(dependent.action("save", undefined));

    expect(result._tag).toBe("Failure");
    await runtime.query({ _tag: "RuntimeEvents" });
    expect(reports.map((report) => report.message)).toEqual([
      "[tests/coverage-expiring-wallet acquire] wallet re-acquire exploded",
      "[tests/coverage-expiring-quote] dependency result expired",
    ]);
  });

  test("a dependency that fails without a readiness attempt is still reported once", async () => {
    const { reports, sink } = collectReports();
    const runtime = createRuntime({ sinks: [sink] });

    await runtime.client
      .node(InvalidKeyParentNode, {})
      .ensureReady()
      .catch(() => undefined);
    await runtime.query({ _tag: "RuntimeEvents" });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain("key exploded");
  });
});
