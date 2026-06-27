import { describe, expect, test } from "bun:test";
import { projectError } from "../src/diagnostics";
import { createRuntime } from "../src/runtime";
import {
  type ActionContract,
  type Dep,
  Driver,
  dep,
  dependencies,
  Effect,
  GraphInvariantViolation,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  resultCommit,
} from "./graphTestFixtures";

describe("result validity", () => {
  test("default acquire commits a current result", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(DefaultValidityNode, {});

    await handle.ensureReady();
    const read = handle.read();
    const snapshot = await handle.snapshot();

    expect(read).toMatchObject({
      _tag: "Ready",
      result: { value: "current" },
      resultValidity: { _tag: "Current" },
    });
    expect(snapshot).toMatchObject({
      _tag: "Found",
      snapshot: { resultValidity: { _tag: "Current" } },
    });
  });

  test("manual stale result stays ready and displayable", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(ManualStaleNode, {});

    await handle.ensureReady();
    const read = handle.read();

    expect(read).toMatchObject({
      _tag: "Ready",
      result: { value: "stale" },
      resultValidity: { _tag: "Stale", staleAt: 10 },
    });
  });

  test("domain result objects with result keys commit as ordinary results", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(BareCommitNode, {});

    await handle.ensureReady();

    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: { result: { value: "domain" } },
      resultValidity: { _tag: "Current" },
    });
  });

  test("explicit result commit wrapper applies validity metadata", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(ManualStaleNode, {});

    await handle.ensureReady();

    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: { value: "stale" },
      resultValidity: { _tag: "Stale", staleAt: 10 },
    });
  });

  test("action setResult preserves current validity unless driver changes it explicitly", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(ActionPreservesValidityNode, {});

    await handle.ensureReady();
    await handle.runAction("rename", { value: "renamed" });

    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: { value: "renamed" },
      resultValidity: { _tag: "Stale", staleAt: 10 },
    });
  });

  test("time-bound policy projects stale validity and rejects expired acquire commits", async () => {
    const runtime = createRuntime();
    const stale = runtime.client.node(TimeBoundStaleNode, {});
    const expired = runtime.client.node(TimeBoundExpiredNode, {});

    await stale.ensureReady();
    await expired.ensureReady();

    expect(stale.read()).toMatchObject({
      _tag: "Ready",
      result: { value: "time-bound-stale" },
      resultValidity: { _tag: "Stale" },
    });
    expect(expired.read()).toMatchObject({
      _tag: "Error",
      error: { _tag: "AcquireFailed", cause: { _tag: "ResultExpired" } },
    });
  });

  test("manual expired result is retained diagnostically and hidden from ordinary ready reads", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(ActionExpiresNode, {});

    await handle.ensureReady();
    await handle.runAction("expire");
    const read = handle.read();
    const rawRead = runtime.client.__unsafe.readNode(handle.nodeId);
    const snapshot = await handle.snapshot();

    expect(read).toMatchObject({
      _tag: "Idle",
    });
    expect(rawRead).toMatchObject({
      _tag: "Expired",
      resultValidity: { _tag: "Expired", expiredAt: 10 },
    });
    expect("result" in read).toBe(false);
    expect(snapshot).toMatchObject({
      _tag: "Found",
      snapshot: { result: { value: "current" } },
    });
  });

  test("stale refresh failure keeps stale ready result", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(StaleRefreshFailureNode, {});

    await handle.ensureReady();
    const refresh = await handle.refresh();

    expect(refresh).toMatchObject({ _tag: "Failure" });
    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: { value: "stale-before-refresh" },
      resultValidity: { _tag: "Stale", staleAt: 10 },
    });
  });

  test("expired invalidation reacquires through normal readiness", async () => {
    acquireAfterExpirationCount = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(ActionExpiresNode, {});

    await handle.ensureReady();
    await handle.runAction("expire");
    expect(handle.read()._tag).toBe("Idle");
    expect(runtime.client.__unsafe.readNode(handle.nodeId)).toMatchObject({ _tag: "Expired" });

    await handle.ensureReady();
    const read = handle.read();
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events.map(
      (record) => record.event
    );

    expect(read).toMatchObject({
      _tag: "Ready",
      result: { value: "reacquired:1" },
      resultValidity: { _tag: "Current" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: "GraphNodeResultValidityChanged",
        previous: expect.objectContaining({ _tag: "Expired" }),
        next: expect.objectContaining({ _tag: "Current" }),
        reason: "acquire",
      })
    );
  });

  test("expired invalidation preserves graph record and live leases while clearing node readiness", async () => {
    acquireAfterExpirationCount = 0;
    actionExpiresLiveStarts.length = 0;
    actionExpiresLiveStops.length = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(ActionExpiresNode, {});

    await handle.ensureReady();
    const before = await handle.snapshot();
    await handle.acquireLiveLease("manual", { pair: "BTC/USD" });
    await handle.runAction("expire");

    await handle.ensureReady();
    const after = await handle.snapshot();

    if (before._tag !== "Found" || after._tag !== "Found") {
      throw new Error("Expected before and after snapshots to be found.");
    }

    expect(after.snapshot.nodeId).toBe(before.snapshot.nodeId);
    expect(after.snapshot.liveDemand).toEqual({
      isLive: true,
      sources: ["manual"],
      scopes: [{ pair: "BTC/USD" }],
    });
    expect(actionExpiresLiveStarts).toHaveLength(2);
    expect(actionExpiresLiveStops).toEqual(["ReadyInvalidated"]);
  });

  test("time-bound expiration emits a validity transition when invalidation starts", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(SoonExpiringInvalidationNode, {});

    await handle.ensureReady();
    await Effect.runPromise(Effect.sleep("60 millis"));
    expect(handle.read()).toMatchObject({ _tag: "Idle" });
    expect(runtime.client.__unsafe.readNode(handle.nodeId)).toMatchObject({ _tag: "Expired" });
    expect(
      (await runtime.query({ _tag: "RuntimeEvents" })).events
        .map((record) => record.event)
        .filter((event) => event._tag === "GraphNodeResultValidityChanged")
    ).toHaveLength(0);

    await handle.ensureReady();
    const validityEvents = (await runtime.query({ _tag: "RuntimeEvents" })).events
      .map((record) => record.event)
      .filter((event) => event._tag === "GraphNodeResultValidityChanged");

    expect(validityEvents).toContainEqual(
      expect.objectContaining({
        _tag: "GraphNodeResultValidityChanged",
        previous: expect.objectContaining({ _tag: "Current" }),
        next: expect.objectContaining({ _tag: "Expired" }),
        reason: "time-bound",
      })
    );
    expect(validityEvents).toContainEqual(
      expect.objectContaining({
        _tag: "GraphNodeResultValidityChanged",
        previous: expect.objectContaining({ _tag: "Expired" }),
        next: expect.objectContaining({ _tag: "Current" }),
        reason: "acquire",
      })
    );
  });

  test("time-bound expiry re-acquire runs driver release and acquire disposers", async () => {
    expiryTeardownReleaseRuns = 0;
    expiryTeardownDisposerRuns = 0;
    expiryTeardownAcquireRuns = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(ExpiryTeardownNode, {});

    await handle.ensureReady();
    expect(expiryTeardownAcquireRuns).toBe(1);
    await Effect.runPromise(Effect.sleep("50 millis"));

    await handle.ensureReady();

    expect(expiryTeardownAcquireRuns).toBe(2);
    expect(expiryTeardownReleaseRuns).toBe(1);
    expect(expiryTeardownDisposerRuns).toBe(1);
    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      resultValidity: { _tag: "Current" },
    });
  });

  test("refresh on an expired result fails without running the refresh driver", async () => {
    expiredRefreshCalls = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(RefreshRejectedWhenExpiredNode, {});

    await handle.ensureReady();
    await handle.runAction("expire");
    const refresh = await handle.refresh();

    expect(refresh).toMatchObject({
      _tag: "Failure",
      error: { _tag: "RefreshFailed", cause: { _tag: "ResultExpired" } },
    });
    expect(expiredRefreshCalls).toBe(0);
  });

  test("dependency staleness does not cascade to dependent validity", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(DependentOnStaleDependencyNode, {});

    await handle.ensureReady();
    const read = handle.read();
    const snapshot = await runtime.getSnapshot();
    const dependency = snapshot.graph.nodes.find(
      (node) => node.tag === "result-validity/stale-dependency"
    );

    expect(read).toMatchObject({
      _tag: "Ready",
      result: { value: "dependent:stale-dependency" },
      resultValidity: { _tag: "Current" },
    });
    expect(dependency?.resultValidity).toMatchObject({ _tag: "Stale", staleAt: 10 });
  });

  test("dependency expiration blocks ordinary dependency result access", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(DependentOnExpiredDependencyNode, {});

    await handle.ensureReady();
    const read = handle.read();

    expect(read).toMatchObject({ _tag: "Error" });

    if (read._tag !== "Error") {
      throw new Error("Expected dependency expiration to block dependent readiness.");
    }

    const projection = projectError(read.error);

    expect(projection.rootTag).toBe("ResultExpired");
    expect(projection.causeChain.some((frame) => frame.tag === "DependencyFailed")).toBe(true);
  });

  test("failed expired invalidation lands in readiness error and does not auto-retry", async () => {
    failingInvalidationAcquireCount = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(FailingExpiredInvalidationNode, {});

    await handle.ensureReady();
    await handle.runAction("expire");

    await handle.ensureReady();
    const snapshot = await handle.snapshot();

    if (snapshot._tag !== "Found") {
      throw new Error("Expected failed invalidation snapshot to be found.");
    }

    const node = snapshot.snapshot.node as { readonly result: unknown };

    expect(() => node.result).toThrow();
    expect(snapshot.snapshot.resultValidity).toMatchObject({ _tag: "Expired" });
    expect(handle.read()).toMatchObject({
      _tag: "Error",
      error: { _tag: "AcquireFailed" },
    });
    expect(failingInvalidationAcquireCount).toBe(2);
    expect(handle.read()).toMatchObject({ _tag: "Error" });
    expect(failingInvalidationAcquireCount).toBe(2);
  });

  test("invalid time-bound policy fails loudly during graph planning", async () => {
    const graph = makeInMemoryGraphSystem();
    const read = await Effect.runPromise(graph.ensureNode({ spec: InvalidPolicyNode, args: {} }));

    expect(read.status).toMatchObject({
      _tag: "Invalid",
      error: { _tag: "GraphInvariantViolation" },
    });
    expect(read.status._tag === "Invalid" ? read.status.error : undefined).toBeInstanceOf(
      GraphInvariantViolation
    );
  });

  test("acquire slower than expireAfter stamps validity at commit time and does not churn", async () => {
    slowTimeBoundAcquireRuns = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(SlowTimeBoundAcquireNode, {});

    await handle.ensureReady();
    expect(slowTimeBoundAcquireRuns).toBe(1);

    await handle.ensureReady();

    expect(slowTimeBoundAcquireRuns).toBe(1);
    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: { value: "slow" },
      resultValidity: { _tag: "Current" },
    });
  });

  test("re-acquire after a same-identity args update passes updated args to the acquire driver", async () => {
    argsUpdateAcquireSeen.length = 0;
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ArgsUpdateReacquireNode, args: { page: 1 } })
    );

    const update = await Effect.runPromise(
      graph.updateNodeArgs({
        nodeId: handle.nodeId,
        spec: ArgsUpdateReacquireNode,
        args: { page: 2 },
      })
    );

    expect(update._tag).toBe("Success");

    await Effect.runPromise(Effect.sleep("60 millis"));
    const reacquired = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ArgsUpdateReacquireNode, args: { page: 2 } })
    );

    expect(reacquired._tag).toBe("Ready");
    expect(argsUpdateAcquireSeen).toEqual([{ page: 1 }, { page: 2 }]);
  });

  test("refresh fails typed when a time-bound dependency is clock-expired", async () => {
    clockExpiredDependencyRefreshRuns = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(DependentOnClockExpiredDependencyNode, {});

    await handle.ensureReady();
    await Effect.runPromise(Effect.sleep("60 millis"));
    const refresh = await handle.refresh();

    expect(refresh).toMatchObject({ _tag: "Failure" });

    if (refresh._tag !== "Failure") {
      throw new Error("Expected clock-expired dependency to fail the refresh.");
    }

    const projection = projectError(refresh.error);

    expect(projection.rootTag).toBe("DependencyResultExpired");
    expect(projection.causeChain.some((frame) => frame.tag === "DependencyFailed")).toBe(true);
    expect(clockExpiredDependencyRefreshRuns).toBe(0);
  });

  test("action fails typed when a time-bound dependency is clock-expired", async () => {
    clockExpiredDependencyActionRuns = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node(DependentOnClockExpiredDependencyNode, {});

    await handle.ensureReady();
    await Effect.runPromise(Effect.sleep("60 millis"));
    const action = await handle.runAction("touch");

    expect(action).toMatchObject({ _tag: "Failure" });

    if (action._tag !== "Failure") {
      throw new Error("Expected clock-expired dependency to fail the action.");
    }

    const projection = projectError(action.error);

    expect(projection.rootTag).toBe("DependencyResultExpired");
    expect(clockExpiredDependencyActionRuns).toBe(0);
  });

  test("invalid result commit metadata fails loudly with typed diagnostics", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node(InvalidCommitNode, {});

    await handle.ensureReady();
    const read = handle.read();

    expect(read).toMatchObject({ _tag: "Error" });

    if (read._tag !== "Error") {
      throw new Error("Expected invalid result commit read error.");
    }

    const projection = projectError(read.error);

    expect(projection.rootTag).toBe("GraphInvariantViolation");
    expect(projection.rootMessage).toBe(
      "result commit loadedAt must be a finite non-negative number"
    );
  });
});

type DefaultValiditySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class DefaultValidityNode extends NodeBase<DefaultValiditySpec> {
  static readonly spec = resourceSpec<DefaultValiditySpec>({
    tag: "result-validity/default",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<DefaultValiditySpec>({
      acquire: Driver.Acquire(() => Effect.succeed({ value: "current" })),
    }),
  });
}

type ManualStaleSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class ManualStaleNode extends NodeBase<ManualStaleSpec> {
  static readonly spec = resourceSpec<ManualStaleSpec>({
    tag: "result-validity/manual-stale",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ManualStaleSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "stale" },
            {
              validity: { _tag: "Stale", staleAt: 10 },
            }
          )
        )
      ),
    }),
  });
}

type BareCommitSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly result: { readonly value: string } };
}>;

class BareCommitNode extends NodeBase<BareCommitSpec> {
  static readonly spec = resourceSpec<BareCommitSpec>({
    tag: "result-validity/bare-commit",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<BareCommitSpec>({
      acquire: Driver.Acquire(() => Effect.succeed({ result: { value: "domain" } })),
    }),
  });
}

type TimeBoundStaleSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class TimeBoundStaleNode extends NodeBase<TimeBoundStaleSpec> {
  static readonly spec = resourceSpec<TimeBoundStaleSpec>({
    tag: "result-validity/time-bound-stale",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<TimeBoundStaleSpec>({
      resultValidity: {
        _tag: "TimeBound",
        staleAfter: "1 millis",
        expireAfter: "100000 weeks",
      },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "time-bound-stale" },
            {
              loadedAt: 0,
            }
          )
        )
      ),
    }),
  });
}

type TimeBoundExpiredSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class TimeBoundExpiredNode extends NodeBase<TimeBoundExpiredSpec> {
  static readonly spec = resourceSpec<TimeBoundExpiredSpec>({
    tag: "result-validity/time-bound-expired",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<TimeBoundExpiredSpec>({
      resultValidity: {
        _tag: "TimeBound",
        expireAfter: "50 millis",
      },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "time-bound-expired" },
            {
              loadedAt: 0,
            }
          )
        )
      ),
    }),
  });
}

let acquireAfterExpirationCount = 0;
const actionExpiresLiveStarts: Array<unknown> = [];
const actionExpiresLiveStops: Array<string> = [];
type ActionExpiresSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
  readonly actions: {
    readonly expire: ActionContract<void, void>;
  };
}>;

class ActionExpiresNode extends NodeBase<ActionExpiresSpec> {
  static readonly spec = resourceSpec<ActionExpiresSpec>({
    tag: "result-validity/action-expires",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ActionExpiresSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => {
        acquireAfterExpirationCount += 1;

        return Effect.succeed({
          value:
            acquireAfterExpirationCount === 1
              ? "current"
              : `reacquired:${acquireAfterExpirationCount - 1}`,
        });
      }),
      actions: {
        expire: Driver.Action((ctx) => ctx.setResultValidity({ _tag: "Expired", expiredAt: 10 })),
      },
      live: Driver.Live({
        start: (_ctx, demand) =>
          Effect.sync(() => {
            actionExpiresLiveStarts.push(demand);
            return "live";
          }),
        stop: (ctx) =>
          Effect.sync(() => {
            actionExpiresLiveStops.push(ctx.reason._tag);
          }),
      }),
    }),
  });
}

type StaleRefreshFailureSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class StaleRefreshFailureNode extends NodeBase<StaleRefreshFailureSpec> {
  static readonly spec = resourceSpec<StaleRefreshFailureSpec>({
    tag: "result-validity/stale-refresh-failure",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<StaleRefreshFailureSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "stale-before-refresh" },
            {
              validity: { _tag: "Stale", staleAt: 10 },
            }
          )
        )
      ),
      refresh: Driver.Refresh(() => Effect.fail(new TypeError("stale refresh failed"))),
    }),
  });
}

let expiredRefreshCalls = 0;
type RefreshRejectedWhenExpiredSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
  readonly actions: {
    readonly expire: ActionContract<void, void>;
  };
}>;

class RefreshRejectedWhenExpiredNode extends NodeBase<RefreshRejectedWhenExpiredSpec> {
  static readonly spec = resourceSpec<RefreshRejectedWhenExpiredSpec>({
    tag: "result-validity/refresh-rejected-when-expired",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<RefreshRejectedWhenExpiredSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "current" })),
      refresh: Driver.Refresh(() => {
        expiredRefreshCalls += 1;
        return Effect.succeed({ value: "refreshed" });
      }),
      actions: {
        expire: Driver.Action((ctx) => ctx.setResultValidity({ _tag: "Expired", expiredAt: 10 })),
      },
    }),
  });
}

type SoonExpiringInvalidationSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class SoonExpiringInvalidationNode extends NodeBase<SoonExpiringInvalidationSpec> {
  static readonly spec = resourceSpec<SoonExpiringInvalidationSpec>({
    tag: "result-validity/soon-expiring-invalidation",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<SoonExpiringInvalidationSpec>({
      resultValidity: {
        _tag: "TimeBound",
        expireAfter: "1 millis",
      },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "current" })),
    }),
  });
}

let expiryTeardownReleaseRuns = 0;
let expiryTeardownDisposerRuns = 0;
let expiryTeardownAcquireRuns = 0;
type ExpiryTeardownSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class ExpiryTeardownNode extends NodeBase<ExpiryTeardownSpec> {
  static readonly spec = resourceSpec<ExpiryTeardownSpec>({
    tag: "result-validity/expiry-teardown",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ExpiryTeardownSpec>({
      resultValidity: {
        _tag: "TimeBound",
        // Margin: wide enough that the post-re-acquire read is not racing the
        // expiry clock, while the 50ms sleep still guarantees expiry.
        expireAfter: "25 millis",
      },
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          expiryTeardownAcquireRuns += 1;
          ctx.disposers.add(() => {
            expiryTeardownDisposerRuns += 1;
          });
          return { value: `acquired:${expiryTeardownAcquireRuns}` };
        })
      ),
      release: Driver.Release(() =>
        Effect.sync(() => {
          expiryTeardownReleaseRuns += 1;
        })
      ),
    }),
  });
}

type ActionPreservesValiditySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
  readonly actions: {
    readonly rename: ActionContract<{ readonly value: string }, void>;
  };
}>;

class ActionPreservesValidityNode extends NodeBase<ActionPreservesValiditySpec> {
  static readonly spec = resourceSpec<ActionPreservesValiditySpec>({
    tag: "result-validity/action-preserves-validity",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ActionPreservesValiditySpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "stale" },
            {
              validity: { _tag: "Stale", staleAt: 10 },
            }
          )
        )
      ),
      actions: {
        rename: Driver.Action((ctx, input) => ctx.setResult({ value: input.value })),
      },
    }),
  });
}

let failingInvalidationAcquireCount = 0;
type FailingExpiredInvalidationSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
  readonly actions: {
    readonly expire: ActionContract<void, void>;
  };
}>;

class FailingExpiredInvalidationNode extends NodeBase<FailingExpiredInvalidationSpec> {
  static readonly spec = resourceSpec<FailingExpiredInvalidationSpec>({
    tag: "result-validity/failing-expired-invalidation",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<FailingExpiredInvalidationSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => {
        failingInvalidationAcquireCount += 1;

        return failingInvalidationAcquireCount === 1
          ? Effect.succeed({ value: "current" })
          : Effect.fail(new TypeError("expired invalidation acquire failed"));
      }),
      actions: {
        expire: Driver.Action((ctx) => ctx.setResultValidity({ _tag: "Expired", expiredAt: 10 })),
      },
    }),
  });
}

type StaleDependencySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class StaleDependencyNode extends NodeBase<StaleDependencySpec> {
  static readonly spec = resourceSpec<StaleDependencySpec>({
    tag: "result-validity/stale-dependency",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<StaleDependencySpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "stale-dependency" },
            {
              validity: { _tag: "Stale", staleAt: 10 },
            }
          )
        )
      ),
    }),
  });
}

type DependentOnStaleDependencySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly dependency: Dep<typeof StaleDependencyNode>;
  };
  readonly result: { readonly value: string };
}>;

class DependentOnStaleDependencyNode extends NodeBase<DependentOnStaleDependencySpec> {
  static readonly spec = resourceSpec<DependentOnStaleDependencySpec>({
    tag: "result-validity/dependent-on-stale",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ dependency: dep(StaleDependencyNode, {}) })),
    driver: Driver.Effect<DependentOnStaleDependencySpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.succeed({ value: `dependent:${ctx.deps.dependency.result.value}` })
      ),
    }),
  });
}

type ExpiredDependencySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class ExpiredDependencyNode extends NodeBase<ExpiredDependencySpec> {
  static readonly spec = resourceSpec<ExpiredDependencySpec>({
    tag: "result-validity/expired-dependency",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ExpiredDependencySpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "expired-dependency" },
            {
              validity: { _tag: "Expired", expiredAt: 10 },
            }
          )
        )
      ),
    }),
  });
}

type DependentOnExpiredDependencySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly dependency: Dep<typeof ExpiredDependencyNode>;
  };
  readonly result: { readonly value: string };
}>;

class DependentOnExpiredDependencyNode extends NodeBase<DependentOnExpiredDependencySpec> {
  static readonly spec = resourceSpec<DependentOnExpiredDependencySpec>({
    tag: "result-validity/dependent-on-expired",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ dependency: dep(ExpiredDependencyNode, {}) })),
    driver: Driver.Effect<DependentOnExpiredDependencySpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.succeed({ value: `dependent:${ctx.deps.dependency.result.value}` })
      ),
    }),
  });
}

type InvalidPolicySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class InvalidPolicyNode extends NodeBase<InvalidPolicySpec> {
  static readonly spec = resourceSpec<InvalidPolicySpec>({
    tag: "result-validity/invalid-policy",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<InvalidPolicySpec>({
      resultValidity: {
        _tag: "TimeBound",
        staleAfter: "10 seconds",
        expireAfter: "5 seconds",
      },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "invalid" })),
    }),
  });
}

let slowTimeBoundAcquireRuns = 0;
type SlowTimeBoundAcquireSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class SlowTimeBoundAcquireNode extends NodeBase<SlowTimeBoundAcquireSpec> {
  static readonly spec = resourceSpec<SlowTimeBoundAcquireSpec>({
    tag: "result-validity/slow-time-bound-acquire",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<SlowTimeBoundAcquireSpec>({
      resultValidity: {
        _tag: "TimeBound",
        expireAfter: "40 millis",
      },
      acquire: Driver.Acquire(() =>
        Effect.gen(function* () {
          slowTimeBoundAcquireRuns += 1;
          yield* Effect.sleep("80 millis");
          return { value: "slow" };
        })
      ),
    }),
  });
}

const argsUpdateAcquireSeen: Array<{ readonly page: number }> = [];
type ArgsUpdateReacquireSpec = NodeSpec<{
  readonly args: { readonly page: number };
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly page: number };
}>;

class ArgsUpdateReacquireNode extends NodeBase<ArgsUpdateReacquireSpec> {
  static readonly spec = resourceSpec<ArgsUpdateReacquireSpec>({
    tag: "result-validity/args-update-reacquire",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ArgsUpdateReacquireSpec>({
      resultValidity: {
        _tag: "TimeBound",
        expireAfter: "20 millis",
      },
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          argsUpdateAcquireSeen.push(ctx.args);
          return { page: ctx.args.page };
        })
      ),
    }),
  });
}

type ClockExpiredDependencySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class ClockExpiredDependencyNode extends NodeBase<ClockExpiredDependencySpec> {
  static readonly spec = resourceSpec<ClockExpiredDependencySpec>({
    tag: "result-validity/clock-expired-dependency",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ClockExpiredDependencySpec>({
      resultValidity: {
        _tag: "TimeBound",
        expireAfter: "20 millis",
      },
      acquire: Driver.Acquire(() => Effect.succeed({ value: "clock-expired-dependency" })),
    }),
  });
}

let clockExpiredDependencyRefreshRuns = 0;
let clockExpiredDependencyActionRuns = 0;
type DependentOnClockExpiredDependencySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly dependency: Dep<typeof ClockExpiredDependencyNode>;
  };
  readonly result: { readonly value: string };
  readonly actions: {
    readonly touch: ActionContract<void, void>;
  };
}>;

class DependentOnClockExpiredDependencyNode extends NodeBase<DependentOnClockExpiredDependencySpec> {
  static readonly spec = resourceSpec<DependentOnClockExpiredDependencySpec>({
    tag: "result-validity/dependent-on-clock-expired",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ dependency: dep(ClockExpiredDependencyNode, {}) })),
    driver: Driver.Effect<DependentOnClockExpiredDependencySpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.succeed({ value: `dependent:${ctx.deps.dependency.result.value}` })
      ),
      refresh: Driver.Refresh((ctx) => {
        clockExpiredDependencyRefreshRuns += 1;
        return ctx.setResult({ value: "refreshed" });
      }),
      actions: {
        touch: Driver.Action((ctx) => {
          clockExpiredDependencyActionRuns += 1;
          return ctx.setResult({ value: "touched" });
        }),
      },
    }),
  });
}

type InvalidCommitSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class InvalidCommitNode extends NodeBase<InvalidCommitSpec> {
  static readonly spec = resourceSpec<InvalidCommitSpec>({
    tag: "result-validity/invalid-commit",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<InvalidCommitSpec>({
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "invalid" },
            {
              loadedAt: Number.POSITIVE_INFINITY,
            }
          )
        )
      ),
    }),
  });
}
