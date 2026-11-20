import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Fiber } from "effect";
import {
  type ActionContract,
  Args,
  createRuntime,
  Driver,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
  unwrapEffect,
} from "../src/index";

// Public-entry contract for join admission: a call joins an operation while it
// runs, and never joins one whose outcome is already decided (the worker
// finished and its settlement is posted but not yet drained) once no caller is
// attached to it.

// One macrotask turn lets a posted plan drain and attach its caller.
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type JoinSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly value: string };
  readonly actions: { readonly write: ActionContract<string, string> };
}>;

function joinNode(name: string, gatedSecondRun = false) {
  const probe = { runs: 0, refreshes: 0 };
  const started = Effect.runSync(Deferred.make<void>());
  const gate = Effect.runSync(Deferred.make<void>());
  const secondStarted = Effect.runSync(Deferred.make<void>());
  const secondGate = Effect.runSync(Deferred.make<void>());
  class JoinNode extends NodeBase<JoinSpec> {
    static readonly spec = resourceSpec.effect<JoinSpec>({
      tag: tag(name),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
      refresh: Driver.Refresh((context) =>
        Effect.gen(function* () {
          probe.refreshes += 1;
          if (probe.refreshes === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
          }
          yield* context.setResult({ value: `refresh:${probe.refreshes}` });
        })
      ),
      actions: {
        write: Driver.Action(
          (context, input) =>
            Effect.gen(function* () {
              probe.runs += 1;
              const value = `${input}:${probe.runs}`;
              if (probe.runs === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(gate);
              }
              if (probe.runs === 2 && gatedSecondRun) {
                yield* Deferred.succeed(secondStarted, undefined);
                yield* Deferred.await(secondGate);
              }
              yield* context.setResult({ value });
              return value;
            }),
          { admission: "join", admissionKey: (input) => input }
        ),
      },
    });
  }
  return { JoinNode, probe, started, gate, secondStarted, secondGate };
}

describe("join admission and decided operations", () => {
  test("a call after the interrupted only caller's worker finished runs a fresh action", async () => {
    const { JoinNode, probe, started, gate } = joinNode("admission-decided/action");
    const runtime = createRuntime();
    const handle = runtime.client.node(JoinNode, Args.none);
    await handle.ensureReady();
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* handle.action("write", "same").pipe(Effect.forkDetach);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(gate, undefined);
        const second = yield* handle.action("write", "same");
        expect(second).toMatchObject({ _tag: "Success", value: "same:2" });
        expect(probe.runs).toBe(2);
      })
    );
    expect(handle.readReady().result).toEqual({ value: "same:2" });
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("a call while the abandoned action still runs joins it", async () => {
    const { JoinNode, probe, started, gate } = joinNode("admission-decided/action-running");
    const runtime = createRuntime();
    const handle = runtime.client.node(JoinNode, Args.none);
    await handle.ensureReady();
    const controller = new AbortController();
    const first = unwrapEffect(handle.action("write", "same", { signal: controller.signal })).catch(
      (cause: unknown) => cause
    );
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    const cause = await first;
    expect(Cause.isCause(cause) && Cause.hasInterruptsOnly(cause)).toBe(true);
    const joined = unwrapEffect(handle.action("write", "same"));
    await macrotask();
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    expect(await joined).toMatchObject({ _tag: "Success", value: "same:1" });
    expect(probe.runs).toBe(1);
    expect(await unwrapEffect(handle.action("write", "same"))).toMatchObject({
      _tag: "Success",
      value: "same:2",
    });
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("a call while the fresh successor runs joins the successor", async () => {
    const { JoinNode, probe, started, gate, secondStarted, secondGate } = joinNode(
      "admission-decided/action-successor",
      true
    );
    const runtime = createRuntime();
    const handle = runtime.client.node(JoinNode, Args.none);
    await handle.ensureReady();
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* handle.action("write", "same").pipe(Effect.forkDetach);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(gate, undefined);
        const second = yield* handle.action("write", "same").pipe(Effect.forkDetach);
        yield* Deferred.await(secondStarted);
        // Start the call now: a plain fork starts on the next setImmediate, and
        // the macrotask below is a timer the event loop may run first.
        const third = yield* handle
          .action("write", "same")
          .pipe(Effect.forkDetach({ startImmediately: true }));
        yield* Effect.promise(macrotask);
        yield* Deferred.succeed(secondGate, undefined);
        expect(yield* Fiber.join(second)).toMatchObject({ _tag: "Success", value: "same:2" });
        expect(yield* Fiber.join(third)).toMatchObject({ _tag: "Success", value: "same:2" });
        expect(probe.runs).toBe(2);
      })
    );
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("a refresh after the interrupted only caller's worker finished runs a fresh refresh", async () => {
    const { JoinNode, probe, started, gate } = joinNode("admission-decided/refresh");
    const runtime = createRuntime();
    const handle = runtime.client.node(JoinNode, Args.none);
    await handle.ensureReady();
    const controller = new AbortController();
    const first = handle.refresh({ signal: controller.signal }).catch((cause: unknown) => cause);
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    await first;
    Effect.runSync(Deferred.succeed(gate, undefined));
    expect(await handle.refresh()).toMatchObject({
      _tag: "Success",
      value: { value: "refresh:2" },
    });
    expect(probe.refreshes).toBe(2);
    await runtime.submit({ _tag: "RuntimeStop" });
  });
});
