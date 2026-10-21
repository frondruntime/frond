import { describe, expect, test } from "bun:test";
import {
  type ActionContract,
  type Dep,
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
  tag,
  unwrapEffect,
} from "../src";
import { createRuntimeReportSink, type FrondErrorReport } from "../src/diagnostics";
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

describe("report coverage: one failure, exactly one report", () => {
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
