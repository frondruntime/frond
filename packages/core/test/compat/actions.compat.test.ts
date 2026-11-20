import { afterEach, describe, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import {
  createDeferred,
  createFrondTestHarness,
  type FrondTestHarness,
} from "@frondruntime/core/testing";
import { Cause, Effect, Exit, Fiber } from "effect";
import { reaction } from "mobx";

const harnesses: FrondTestHarness[] = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

function createHarness() {
  const harness = createFrondTestHarness();
  harnesses.push(harness);
  return harness;
}

type LedgerSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly account: string };
  readonly key: Frond.Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { balance: number; entries: string[] };
  readonly actions: {
    readonly replace: Frond.ActionContract<number, string>;
    readonly append: Frond.ActionContract<string, string>;
    readonly fail: Frond.ActionContract<"throw" | "reject", never>;
  };
}>;

const rejectedTransfer = { _tag: "TransferRejected", account: "checking" } as const;

class LedgerNode extends Frond.NodeBase<LedgerSpec> {
  static readonly spec = Frond.resourceSpec.async<LedgerSpec>({
    tag: Frond.tag("compat/actions/ledger"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(() => ({ balance: 0, entries: [] })),
    actions: {
      replace: Frond.Driver.Action((context, balance) => {
        context.setResult({ balance, entries: ["replaced"] });
        return `receipt:${balance}`;
      }),
      append: Frond.Driver.Action((context, entry) => {
        context.patchResult((result) => {
          result.balance += 1;
          result.entries.push(entry);
        });
        return `accepted:${entry}`;
      }),
      fail: Frond.Driver.Action((context, mode) => {
        context.patchResult((result) => {
          result.balance = -1;
          result.entries.push("uncommitted");
        });
        if (mode === "throw") throw rejectedTransfer;
        return Promise.reject(rejectedTransfer);
      }),
    },
  });
}

describe("0.5 action compatibility", () => {
  test("authored actions return receipts while MobX and client actions return success outcomes", async () => {
    const harness = createHarness();
    const handle = harness.node(LedgerNode, { account: "checking" });
    const projection = Frond.MobX.createNode(harness.runtime, LedgerNode, handle.args);
    disposers.push(() => projection.dispose());
    await projection.ensureReady();

    expect(await projection.node.actions.replace(10)).toBe("receipt:10");
    expect(projection.node.result).toEqual({ balance: 10, entries: ["replaced"] });
    expect(await projection.runAction("append", "mobx")).toEqual({
      _tag: "Success",
      nodeId: handle.nodeId,
      value: "accepted:mobx",
    });
    expect(projection.result).toEqual({ balance: 11, entries: ["replaced", "mobx"] });
    expect(await handle.actions.append("client")).toEqual({
      _tag: "Success",
      nodeId: handle.nodeId,
      value: "accepted:client",
    });
    expect(handle.readReady().result).toEqual({
      balance: 12,
      entries: ["replaced", "mobx", "client"],
    });
    expect(await Frond.unwrapEffect(handle.action("replace", 20))).toEqual({
      _tag: "Success",
      nodeId: handle.nodeId,
      value: "receipt:20",
    });
    expect(handle.readReady().result).toEqual({ balance: 20, entries: ["replaced"] });
  });

  for (const mode of ["throw", "reject"] as const) {
    test(`${mode} failures reject authored actions and return failures through MobX and client actions without committing patches`, async () => {
      const harness = createHarness();
      const handle = harness.node(LedgerNode, { account: "checking" });
      const projection = Frond.MobX.createNode(harness.runtime, LedgerNode, handle.args);
      disposers.push(() => projection.dispose());
      await projection.ensureReady();
      await projection.node.actions.replace(7);
      const expectedError = {
        _tag: "ActionFailed",
        nodeId: handle.nodeId,
        tag: LedgerNode.spec.tag,
        action: "fail",
        input: mode,
        cause: { _tag: "DriverPromiseFailed", operation: "action:fail", cause: rejectedTransfer },
      };
      const observed = [JSON.stringify(projection.node.result)];
      disposers.push(
        reaction(
          () => JSON.stringify(projection.node.result),
          (state) => observed.push(state)
        )
      );

      const rejection: unknown = await projection.node.actions
        .fail(mode)
        .catch((error: unknown) => error);
      expect(rejection).toMatchObject(expectedError);
      expect(await projection.runAction("fail", mode)).toMatchObject({
        _tag: "Failure",
        error: expectedError,
      });
      expect(projection.operationFailure).toMatchObject({ kind: "action", error: expectedError });
      expect(projection.failure).toBeUndefined();
      expect(projection.busy).toBe(false);
      expect(await handle.actions.fail(mode)).toMatchObject({
        _tag: "Failure",
        error: expectedError,
      });
      expect(await Frond.unwrapEffect(handle.action("fail", mode))).toMatchObject({
        _tag: "Failure",
        error: expectedError,
      });
      expect(handle.readReady().result).toEqual({ balance: 7, entries: ["replaced"] });
      expect(projection.result).toEqual({ balance: 7, entries: ["replaced"] });
      expect(
        observed.filter((state, index) => index === 0 || state !== observed[index - 1])
      ).toEqual([JSON.stringify({ balance: 7, entries: ["replaced"] })]);
      await projection.runAction("append", "recovered");
      expect(projection.operationFailure).toBeUndefined();
      expect(projection.result).toEqual({ balance: 8, entries: ["replaced", "recovered"] });
    });
  }

  for (const mode of ["failure", "defect"] as const) {
    test(`Effect ${mode} fails authored actions and returns a structured client and MobX failure with patch rollback`, async () => {
      type EffectLedgerSpec = Frond.NodeSpec<{
        readonly mode: "effect";
        readonly args: Frond.Args.None;
        readonly deps: Record<string, never>;
        readonly result: { balance: number };
        readonly actions: {
          readonly replace: Frond.ActionContract<number, string>;
          readonly fail: Frond.ActionContract<void, never>;
        };
      }>;
      // effect-mode: characterize the released Effect action surface — authorized by this task.
      class EffectLedgerNode extends Frond.NodeBase<EffectLedgerSpec> {
        static readonly spec = Frond.resourceSpec.effect<EffectLedgerSpec>({
          tag: Frond.tag("compat/actions/effect-ledger"),
          key: () => Frond.Key.singleton(),
          acquire: Frond.Driver.Acquire(() => Effect.succeed({ balance: 0 })),
          actions: {
            replace: Frond.Driver.Action((context, balance) =>
              Effect.gen(function* () {
                yield* context.setResult({ balance });
                yield* context.patchResult((result) => {
                  result.balance += 1;
                });
                return `receipt:${balance}`;
              })
            ),
            fail: Frond.Driver.Action((context) =>
              Effect.gen(function* () {
                yield* context.patchResult((result) => {
                  result.balance = -1;
                });
                return yield* mode === "failure"
                  ? Effect.fail(rejectedTransfer)
                  : Effect.die(rejectedTransfer);
              })
            ),
          },
        });
      }
      const harness = createHarness();
      const handle = harness.node(EffectLedgerNode, Frond.Args.none);
      const projection = Frond.MobX.createNode(harness.runtime, EffectLedgerNode, Frond.Args.none);
      disposers.push(() => projection.dispose());
      await projection.ensureReady();
      expect(await Frond.unwrapEffect(projection.node.actions.replace(4))).toBe("receipt:4");
      expect(projection.node.result).toEqual({ balance: 5 });
      expect(await Frond.unwrapEffect(handle.actions.replace(6))).toMatchObject({
        _tag: "Success",
        value: "receipt:6",
      });
      const expectedError = {
        _tag: "ActionFailed",
        nodeId: handle.nodeId,
        tag: EffectLedgerNode.spec.tag,
        action: "fail",
        input: undefined,
        // 0.5 behavior: typed Effect failures stay direct causes; defects gain a boundary wrapper.
        cause:
          mode === "failure"
            ? rejectedTransfer
            : {
                _tag: "EffectBoundaryFailed",
                boundary: "driver-action",
                cause: rejectedTransfer,
              },
      };
      const failure = await Effect.runPromise(Effect.flip(projection.node.actions.fail()));
      expect(failure).toMatchObject(expectedError);
      expect(await Frond.unwrapEffect(handle.actions.fail())).toMatchObject({
        _tag: "Failure",
        error: expectedError,
      });
      expect(await projection.runAction("fail")).toMatchObject({
        _tag: "Failure",
        error: expectedError,
      });
      expect(projection.result).toEqual({ balance: 7 });
      expect(projection.operationFailure).toMatchObject({ kind: "action", error: expectedError });
      expect(handle.readReady().result).toEqual({ balance: 7 });
    });
  }

  test("concurrent actions on one node commit in FIFO order across an asynchronous boundary", async () => {
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    type QueueSpec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly args: Frond.Args.None;
      readonly result: { entries: string[] };
      readonly actions: { readonly append: Frond.ActionContract<string, string> };
    }>;
    class QueueNode extends Frond.NodeBase<QueueSpec> {
      static readonly spec = Frond.resourceSpec.async<QueueSpec>({
        tag: Frond.tag("compat/actions/queue"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => ({ entries: [] })),
        actions: {
          append: Frond.Driver.Action(async (context, entry) => {
            if (entry === "first") {
              entered.resolve();
              await gate.promise;
            }
            context.patchResult((result) => {
              result.entries.push(entry);
            });
            return entry;
          }),
        },
      });
    }
    const harness = createHarness();
    const node = await harness.startNode(QueueNode, Frond.Args.none);
    const observed = [""];
    disposers.push(
      reaction(
        () => node.result.entries.join(","),
        (state) => {
          if (observed.at(-1) !== state) observed.push(state);
        }
      )
    );
    const first = node.actions.append("first");
    await entered.promise;
    const second = node.actions.append("second");
    const third = node.actions.append("third");
    expect(node.result.entries).toEqual([]);
    gate.resolve();
    expect(await Promise.all([first, second, third])).toEqual(["first", "second", "third"]);
    expect(node.result.entries).toEqual(["first", "second", "third"]);
    expect(observed).toEqual(["", "first", "first,second", "first,second,third"]);
  });

  test("identical joinable actions share an outcome while distinct inputs perform distinct work", async () => {
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    type JoinSpec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly args: Frond.Args.None;
      readonly result: { entries: string[] };
      readonly actions: { readonly append: Frond.ActionContract<string, string> };
    }>;
    class JoinNode extends Frond.NodeBase<JoinSpec> {
      static readonly spec = Frond.resourceSpec.async<JoinSpec>({
        tag: Frond.tag("compat/actions/join"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => ({ entries: [] })),
        actions: {
          append: Frond.Driver.Action(
            async (context, entry) => {
              entered.resolve();
              await gate.promise;
              context.patchResult((result) => {
                result.entries.push(entry);
              });
              return `accepted:${entry}`;
            },
            { admission: "join", admissionKey: (entry) => entry }
          ),
        },
      });
    }
    const harness = createHarness();
    const node = await harness.startNode(JoinNode, Frond.Args.none);
    const first = node.actions.append("same");
    await entered.promise;
    const joined = node.actions.append("same");
    const distinct = node.actions.append("different");
    gate.resolve();
    expect(await Promise.all([first, joined, distinct])).toEqual([
      "accepted:same",
      "accepted:same",
      "accepted:different",
    ]);
    expect(node.result.entries).toEqual(["same", "different"]);
  });

  test("actions on different node identities complete independently while another node is blocked", async () => {
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    type ParallelSpec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly args: { readonly account: string };
      readonly key: Frond.Key.Structure<{ readonly account: string }>;
      readonly result: { value: string };
      readonly actions: { readonly write: Frond.ActionContract<string, string> };
    }>;
    class ParallelNode extends Frond.NodeBase<ParallelSpec> {
      static readonly spec = Frond.resourceSpec.async<ParallelSpec>({
        tag: Frond.tag("compat/actions/parallel"),
        key: (args) => Frond.Key.structure(args),
        acquire: Frond.Driver.Acquire(() => ({ value: "initial" })),
        actions: {
          write: Frond.Driver.Action(async (context, value) => {
            if (context.args.account === "blocked") {
              entered.resolve();
              await gate.promise;
            }
            context.setResult({ value });
            return value;
          }),
        },
      });
    }
    const harness = createHarness();
    const blocked = await harness.startNode(ParallelNode, { account: "blocked" });
    const independent = await harness.startNode(ParallelNode, { account: "independent" });
    const pending = blocked.actions.write("later");
    await entered.promise;
    expect(await independent.actions.write("now")).toBe("now");
    expect(independent.result.value).toBe("now");
    expect(blocked.result.value).toBe("initial");
    gate.resolve();
    expect(await pending).toBe("later");
    expect(blocked.result.value).toBe("later");
  });

  for (const cancellation of ["signal", "interruption"] as const) {
    test(`${cancellation} of the only joinable action caller lets an immediate repeated call after its worker finished run fresh work`, async () => {
      const entered = createDeferred<void>();
      const gate = createDeferred<void>();
      const finished = createDeferred<void>();
      let generation = 0;
      type CancelSpec = Frond.NodeSpec<{
        readonly mode: "async";
        readonly args: Frond.Args.None;
        readonly result: { value: string };
        readonly actions: { readonly write: Frond.ActionContract<string, string> };
      }>;
      class CancelNode extends Frond.NodeBase<CancelSpec> {
        static readonly spec = Frond.resourceSpec.async<CancelSpec>({
          tag: Frond.tag("compat/actions/cancel"),
          key: () => Frond.Key.singleton(),
          acquire: Frond.Driver.Acquire(() => ({ value: "initial" })),
          actions: {
            write: Frond.Driver.Action(
              async (context, input) => {
                const value = `${input}:${++generation}`;
                if (generation === 1) {
                  entered.resolve();
                  await gate.promise;
                }
                context.setResult({ value });
                finished.resolve();
                return value;
              },
              { admission: "join", admissionKey: (input) => input }
            ),
          },
        });
      }
      const harness = createHarness();
      const handle = harness.node(CancelNode, Frond.Args.none);
      await handle.ensureReady();
      const controller = new AbortController();
      const operation = handle.action("write", "same", { signal: controller.signal });
      if (cancellation === "signal") {
        const rejected = Frond.unwrapEffect(operation).catch((cause: unknown) => cause);
        await entered.promise;
        controller.abort();
        const cause = await rejected;
        expect(Cause.isCause(cause)).toBe(true);
        if (!Cause.isCause(cause)) throw new Error("Expected an interruption cause");
        expect(Cause.hasInterrupts(cause)).toBe(true);
      } else {
        const fiber = Effect.runFork(operation);
        await entered.promise;
        await Effect.runPromise(Fiber.interrupt(fiber));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      }
      gate.resolve();
      await finished.promise;
      expect(handle.readReady().result).toEqual({ value: "initial" });
      // 0.6 intended change: 0.5 left the join admitted until the late worker reply drained, so
      // an immediate repeat received the abandoned operation's value. 0.6 releases a join's
      // admission once its outcome is decided and no caller is attached: the cancelled only
      // caller detached, so the repeat (posted before the worker's edge, drained after it) runs
      // fresh work, FIFO behind the abandoned operation's commit (as 0.5's graph-actions test pins).
      expect(await handle.actions.write("same")).toMatchObject({
        _tag: "Success",
        value: "same:2",
      });
      expect(handle.readReady().result).toEqual({ value: "same:2" });
      expect(await handle.actions.write("same")).toMatchObject({
        _tag: "Success",
        value: "same:3",
      });
      expect(handle.readReady().result).toEqual({ value: "same:3" });
    });

    test(`${cancellation} of the only joinable action caller lets a repeated call made while its worker runs join it`, async () => {
      const entered = createDeferred<void>();
      const gate = createDeferred<void>();
      let generation = 0;
      type RunningSpec = Frond.NodeSpec<{
        readonly mode: "async";
        readonly args: Frond.Args.None;
        readonly result: { value: string };
        readonly actions: { readonly write: Frond.ActionContract<string, string> };
      }>;
      class RunningNode extends Frond.NodeBase<RunningSpec> {
        static readonly spec = Frond.resourceSpec.async<RunningSpec>({
          tag: Frond.tag("compat/actions/cancel-running"),
          key: () => Frond.Key.singleton(),
          acquire: Frond.Driver.Acquire(() => ({ value: "initial" })),
          actions: {
            write: Frond.Driver.Action(
              async (context, input) => {
                const value = `${input}:${++generation}`;
                if (generation === 1) {
                  entered.resolve();
                  await gate.promise;
                }
                context.setResult({ value });
                return value;
              },
              { admission: "join", admissionKey: (input) => input }
            ),
          },
        });
      }
      const harness = createHarness();
      const handle = harness.node(RunningNode, Frond.Args.none);
      await handle.ensureReady();
      const controller = new AbortController();
      const operation = handle.action("write", "same", { signal: controller.signal });
      if (cancellation === "signal") {
        const rejected = Frond.unwrapEffect(operation).catch((cause: unknown) => cause);
        await entered.promise;
        controller.abort();
        expect(Cause.isCause(await rejected)).toBe(true);
      } else {
        const fiber = Effect.runFork(operation);
        await entered.promise;
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      // The repeat attaches to the abandoned operation while its worker is still gated.
      const repeated = handle.actions.write("same");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      gate.resolve();
      expect(await repeated).toMatchObject({ _tag: "Success", value: "same:1" });
      expect(generation).toBe(1);
      expect(handle.readReady().result).toEqual({ value: "same:1" });
    });
  }

  test("interrupting an authored Effect action lets its worker commit and a later call starts fresh", async () => {
    const entered = createDeferred<AbortSignal>();
    const gate = createDeferred<void>();
    const finished = createDeferred<void>();
    let generation = 0;
    type InterruptSpec = Frond.NodeSpec<{
      readonly mode: "effect";
      readonly args: Frond.Args.None;
      readonly result: { value: string };
      readonly actions: { readonly write: Frond.ActionContract<string, string> };
    }>;
    // effect-mode: exercise caller interruption through the public authored action — authorized by this task.
    class InterruptNode extends Frond.NodeBase<InterruptSpec> {
      static readonly spec = Frond.resourceSpec.effect<InterruptSpec>({
        tag: Frond.tag("compat/actions/interrupt-effect"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => Effect.succeed({ value: "initial" })),
        actions: {
          write: Frond.Driver.Action(
            (context, input) =>
              Effect.gen(function* () {
                const value = `${input}:${++generation}`;
                if (generation === 1) {
                  entered.resolve(context.signal);
                  yield* Effect.promise(() => gate.promise).pipe(
                    Effect.ensuring(Effect.sync(() => finished.resolve()))
                  );
                }
                yield* context.setResult({ value });
                return value;
              }),
            { admission: "join", admissionKey: (input) => input }
          ),
        },
      });
    }
    const harness = createHarness();
    const node = await harness.startNode(InterruptNode, Frond.Args.none);
    const completed = createDeferred<void>();
    const subscription = harness.runtime.observe((record) => {
      if (record.event._tag === "GraphActionSucceeded" && record.event.nodeId === node.nodeId)
        completed.resolve();
    });
    disposers.push(() => subscription.unsubscribe());
    const fiber = Effect.runFork(node.actions.write("same"));
    const signal = await entered.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    // 0.5 behavior: authored Effect caller interruption does not abort the detached worker.
    expect(signal.aborted).toBe(false);
    gate.resolve();
    await finished.promise;
    await completed.promise;
    expect(node.result).toEqual({ value: "same:1" });
    expect(await Frond.unwrapEffect(node.actions.write("same"))).toBe("same:2");
    expect(node.result).toEqual({ value: "same:2" });
  });

  test("interrupting the only dependency refresh caller lets refresh commit and a later refresh starts fresh", async () => {
    const entered = createDeferred<AbortSignal>();
    const gate = createDeferred<void>();
    const finished = createDeferred<void>();
    let generation = 0;
    type TargetSpec = Frond.NodeSpec<{
      readonly mode: "effect";
      readonly args: Frond.Args.None;
      readonly result: { value: string };
    }>;
    // effect-mode: characterize scoped dependency refresh cancellation — authorized by this task.
    class TargetNode extends Frond.NodeBase<TargetSpec> {
      static readonly spec = Frond.resourceSpec.effect<TargetSpec>({
        tag: Frond.tag("compat/actions/interrupt-refresh-target"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => Effect.succeed({ value: "initial" })),
        refresh: Frond.Driver.Refresh((context) =>
          Effect.gen(function* () {
            const value = `refresh:${++generation}`;
            if (generation === 1) {
              entered.resolve(context.signal);
              yield* Effect.promise(() => gate.promise).pipe(
                Effect.ensuring(Effect.sync(() => finished.resolve()))
              );
            }
            yield* context.setResult({ value });
          })
        ),
      });
    }
    type CoordinatorSpec = Frond.NodeSpec<{
      readonly mode: "effect";
      readonly args: Frond.Args.None;
      readonly deps: { readonly target: Frond.Dep<typeof TargetNode> };
      readonly result: { readonly ready: true };
      readonly actions: { readonly refresh: Frond.ActionContract<void, void> };
    }>;
    // effect-mode: owns a cancellable refresh of a declared dependency — authorized by this task.
    class CoordinatorNode extends Frond.NodeBase<CoordinatorSpec> {
      static readonly spec = Frond.facadeSpec.effect<CoordinatorSpec>({
        tag: Frond.tag("compat/actions/interrupt-refresh-coordinator"),
        key: () => Frond.Key.singleton(),
        dependencies: Frond.dependencies(() => ({
          target: Frond.dep(TargetNode, Frond.Args.none),
        })),
        acquire: Frond.Driver.Acquire(() => Effect.succeed({ ready: true as const })),
        actions: {
          refresh: Frond.Driver.Action((context) =>
            context.refreshDep("target").pipe(Effect.asVoid)
          ),
        },
      });
    }
    const harness = createHarness();
    const coordinator = await harness.startNode(CoordinatorNode, Frond.Args.none);
    const target = harness.node(TargetNode, Frond.Args.none);
    const completed = createDeferred<void>();
    disposers.push(
      target.subscribe(() => {
        const read = target.read();
        if (read._tag === "Ready" && !read.busy && read.result.value === "refresh:1")
          completed.resolve();
      })
    );
    const fiber = Effect.runFork(coordinator.actions.refresh());
    const signal = await entered.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    // 0.5 behavior: interrupting this caller leaves its dependency refresh alive.
    expect(signal.aborted).toBe(false);
    gate.resolve();
    await finished.promise;
    await completed.promise;
    expect(target.readReady().result).toEqual({ value: "refresh:1" });
    expect(await target.refresh()).toEqual({
      _tag: "Success",
      nodeId: target.nodeId,
      value: { value: "refresh:2" },
    });
    expect(target.readReady().result).toEqual({ value: "refresh:2" });
  });

  test("aborting refresh metadata leaves the refresh running and the next refresh performs fresh work", async () => {
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    let generation = 0;
    type RefreshSpec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly args: Frond.Args.None;
      readonly result: { value: string };
    }>;
    class RefreshNode extends Frond.NodeBase<RefreshSpec> {
      static readonly spec = Frond.resourceSpec.async<RefreshSpec>({
        tag: Frond.tag("compat/actions/cancel-refresh"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => ({ value: "initial" })),
        refresh: Frond.Driver.Refresh(async (context) => {
          const value = `refresh:${++generation}`;
          if (generation === 1) {
            entered.resolve();
            await gate.promise;
          }
          context.setResult({ value });
        }),
      });
    }
    const harness = createHarness();
    const handle = harness.node(RefreshNode, Frond.Args.none);
    await handle.ensureReady();
    const controller = new AbortController();
    const first = handle.refresh({ signal: controller.signal }).catch((cause: unknown) => cause);
    await entered.promise;
    controller.abort();
    // 0.6 intended change: 0.5 ignored the refresh signal. 0.6 settles the aborted refresh
    // caller as an aborted action caller settles (it rejects with the interruption Cause), and
    // the refresh worker is still not cancelled: it keeps running and commits.
    const cause = await first;
    expect(Cause.isCause(cause)).toBe(true);
    if (!Cause.isCause(cause)) throw new Error("Expected an interruption cause");
    expect(Cause.hasInterruptsOnly(cause)).toBe(true);
    const committed = createDeferred<void>();
    disposers.push(
      handle.subscribe(() => {
        const read = handle.read();
        if (read._tag === "Ready" && !read.busy && read.result.value === "refresh:1")
          committed.resolve();
      })
    );
    gate.resolve();
    await committed.promise;
    expect(handle.readReady().result).toEqual({ value: "refresh:1" });
    expect(await handle.refresh()).toEqual({
      _tag: "Success",
      nodeId: handle.nodeId,
      value: { value: "refresh:2" },
    });
    expect(handle.readReady().result).toEqual({ value: "refresh:2" });
  });
});
