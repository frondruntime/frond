import { afterEach, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import {
  createDeferred,
  createFrondTestHarness,
  type FrondTestHarness,
} from "@frondruntime/core/testing";
import { Cause } from "effect";

// MIGRATION-0.6.md, section 10: graph work runs in one microtask drain, never
// in the caller's synchronous frame.

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

type DraftSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Frond.Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly draft: string };
  readonly actions: {
    readonly save: Frond.ActionContract<string, string>;
    readonly hold: Frond.ActionContract<void, string>;
  };
}>;

function draftNode(name: string) {
  const runs = { hold: 0, signal: undefined as AbortSignal | undefined };
  const entered = createDeferred<void>();
  class DraftNode extends Frond.NodeBase<DraftSpec> {
    static readonly spec = Frond.resourceSpec.async<DraftSpec>({
      tag: Frond.tag(`compat/queue-deferral/${name}`),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => ({ draft: "" })),
      actions: {
        save: Frond.Driver.Action((context, draft) => {
          context.setResult({ draft });
          return draft;
        }),
        hold: Frond.Driver.Action(async (context) => {
          runs.hold += 1;
          runs.signal = context.signal;
          entered.resolve();
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve())
          );
          return "held";
        }),
      },
    });
  }
  return { DraftNode, runs, entered };
}

test("a call returns before its driver runs, so a read in the same frame sees the old result", async () => {
  const { DraftNode } = draftNode("same-frame-read");
  const harness = createHarness();
  const projection = Frond.MobX.createNode(harness.runtime, DraftNode, {});
  disposers.push(() => projection.dispose());
  await projection.ensureReady();

  const saving = projection.node.actions.save("unsaved");
  // 0.6 intended change: 0.5 ran a synchronous driver in the caller's frame and
  // read "unsaved" here. 0.6 posts the call to the graph queue.
  expect(projection.node.result.draft).toBe("");
  expect(await saving).toBe("unsaved");
  expect(projection.node.result.draft).toBe("unsaved");
});

test("an abort in the same tick as the call cancels it before its driver runs", async () => {
  const { DraftNode, runs } = draftNode("same-tick-abort");
  const harness = createHarness();
  const handle = harness.node(DraftNode, {});
  await handle.ensureReady();

  const controller = new AbortController();
  const rejected = Frond.unwrapEffect(
    handle.action("hold", undefined, { signal: controller.signal })
  ).catch((cause: unknown) => cause);
  controller.abort();
  const cause = await rejected;
  await harness.waitForIdle();

  expect(Cause.isCause(cause) && Cause.hasInterrupts(cause)).toBe(true);
  // 0.6 intended change: 0.5 ran the driver once, which then saw the abort.
  expect(runs.hold).toBe(0);
});

test("a caller abort reaches ctx.signal once the queue drains, before the caller's rejection", async () => {
  const { DraftNode, runs, entered } = draftNode("signal-after-drain");
  const harness = createHarness();
  const handle = harness.node(DraftNode, {});
  await handle.ensureReady();

  const controller = new AbortController();
  let abortedAtRejection: boolean | undefined;
  const rejected = Frond.unwrapEffect(
    handle.action("hold", undefined, { signal: controller.signal })
  ).catch(() => {
    abortedAtRejection = runs.signal?.aborted;
  });
  await entered.promise;
  controller.abort();
  // 0.6 intended change: 0.5 aborted the driver's signal synchronously, inside
  // controller.abort().
  expect(runs.signal?.aborted).toBe(false);
  await rejected;
  expect(abortedAtRejection).toBe(true);
});
