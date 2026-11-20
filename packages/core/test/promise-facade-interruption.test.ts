import { describe, expect, test } from "bun:test";
import { Cause } from "effect";
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
} from "../src/index";

// Public-entry contract for the Promise facade: an aborted or interrupted
// Promise caller rejects with its interruption `Cause`, the same rejection an
// aborted action caller gets through `unwrapEffect`. Effect's squashed
// "All fibers interrupted without error" Error never escapes a Promise method.

const rawInterruptionMessage = "All fibers interrupted without error";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected the Promise to reject");
}

function expectInterruptedCause(cause: unknown): void {
  expect(cause instanceof Error && cause.message === rawInterruptionMessage).toBe(false);
  expect(Cause.isCause(cause)).toBe(true);
  if (!Cause.isCause(cause)) return;
  expect(Cause.hasInterruptsOnly(cause)).toBe(true);
}

type GatedSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: { readonly value: string };
  readonly actions: { readonly write: ActionContract<string, string> };
}>;

function gatedNode(name: string, options: { readonly gateAcquire: boolean }) {
  const entered = deferred();
  const gate = deferred();
  let refreshes = 0;
  class GatedNode extends NodeBase<GatedSpec> {
    static readonly spec = resourceSpec.async<GatedSpec>({
      tag: tag(name),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => {
        if (options.gateAcquire) {
          entered.resolve();
          await gate.promise;
        }
        return { value: "initial" };
      }),
      refresh: Driver.Refresh(async (context) => {
        const value = `refresh:${++refreshes}`;
        if (refreshes === 1) {
          entered.resolve();
          await gate.promise;
        }
        context.setResult({ value });
      }),
      actions: {
        write: Driver.Action(async (context, input) => {
          entered.resolve();
          await gate.promise;
          context.setResult({ value: input });
          return input;
        }),
      },
    });
  }
  return { GatedNode, entered, gate };
}

describe("Promise facade interruption", () => {
  test("aborting refresh rejects with the interruption Cause while the worker commits", async () => {
    const { GatedNode, entered, gate } = gatedNode("facade-interruption/refresh", {
      gateAcquire: false,
    });
    const runtime = createRuntime();
    const handle = runtime.client.node(GatedNode, Args.none);
    await handle.ensureReady();
    const controller = new AbortController();
    const first = rejection(handle.refresh({ signal: controller.signal }));
    await entered.promise;
    controller.abort();
    expectInterruptedCause(await first);
    const committed = deferred();
    const unsubscribe = handle.subscribe(() => {
      const read = handle.read();
      if (read._tag === "Ready" && !read.busy && read.result.value === "refresh:1")
        committed.resolve();
    });
    gate.resolve();
    await committed.promise;
    unsubscribe();
    expect(await handle.refresh()).toMatchObject({
      _tag: "Success",
      value: { value: "refresh:2" },
    });
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("an already-aborted refresh signal rejects with the interruption Cause", async () => {
    const { GatedNode } = gatedNode("facade-interruption/refresh-pre-aborted", {
      gateAcquire: false,
    });
    const runtime = createRuntime();
    const handle = runtime.client.node(GatedNode, Args.none);
    await handle.ensureReady();
    const controller = new AbortController();
    controller.abort();
    expectInterruptedCause(await rejection(handle.refresh({ signal: controller.signal })));
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("aborting ensureReady and ensureReadyNode rejects with the interruption Cause", async () => {
    const { GatedNode, entered, gate } = gatedNode("facade-interruption/ready", {
      gateAcquire: true,
    });
    const runtime = createRuntime();
    const handle = runtime.client.node(GatedNode, Args.none);
    const readyController = new AbortController();
    const nodeController = new AbortController();
    const ready = rejection(handle.ensureReady({ signal: readyController.signal }));
    const node = rejection(handle.ensureReadyNode({ signal: nodeController.signal }));
    await entered.promise;
    readyController.abort();
    nodeController.abort();
    expectInterruptedCause(await ready);
    expectInterruptedCause(await node);
    gate.resolve();
    expect((await handle.ensureReady())._tag).toBe("Ready");
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("aborting boot settles its attempt with the interruption Cause as the read error", async () => {
    const { GatedNode, entered, gate } = gatedNode("facade-interruption/boot", {
      gateAcquire: true,
    });
    const runtime = createRuntime();
    const handle = runtime.client.node(GatedNode, Args.none);
    const controller = new AbortController();
    const read = handle.boot({ signal: controller.signal });
    expect(read._tag).toBe("Pending");
    if (read._tag !== "Pending" || read.attempt === undefined) throw new Error("Expected a boot");
    await entered.promise;
    controller.abort();
    const settled = await read.attempt;
    expect(settled._tag).toBe("Error");
    if (settled._tag === "Error") expectInterruptedCause(settled.error);
    gate.resolve();
    expect((await handle.ensureReady())._tag).toBe("Ready");
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("an async action caller stopped with the runtime resolves with a typed outcome", async () => {
    const { GatedNode, entered } = gatedNode("facade-interruption/action-stop", {
      gateAcquire: false,
    });
    const runtime = createRuntime();
    const handle = runtime.client.node(GatedNode, Args.none);
    await handle.ensureReady();
    const pending = handle.actions.write("late");
    await entered.promise;
    await runtime.submit({ _tag: "RuntimeStop" });
    expect(await pending).toMatchObject({
      _tag: "Failure",
      error: { _tag: "ActionFailed", action: "write" },
    });
  });
});
