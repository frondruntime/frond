import { expect, test } from "bun:test";
import { _resetGlobalState, autorun, configure } from "mobx";
import * as Frond from "../src";
import * as FrondTest from "../src/testing";

type Spec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly result: { value: number };
  readonly actions: { readonly replace: Frond.ActionContract };
}>;

class Counter extends Frond.NodeBase<Spec> {
  static readonly spec = Frond.serviceSpec.async<Spec>({
    tag: Frond.tag("test/commit-reaction-failure"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(() => ({ value: 0 })),
    refresh: Frond.Driver.Refresh((context) => context.setResult({ value: 1 })),
    actions: {
      replace: Frond.Driver.Action((context) => context.setResult({ value: 1 })),
    },
  });
}

for (const operation of ["action", "refresh", "unsafeUpdate"] as const) {
  test(`${operation} succeeds and reports a reaction failure after its commit`, async () => {
    const harness = FrondTest.createFrondTestHarness();
    const node = await harness.startNode(Counter, {});
    const handle = harness.node(Counter, {});
    const failure = new Error("reaction rejected the committed value");
    const order: string[] = [];
    const unsubscribe = handle.subscribe(() => {
      if (node.result.value === 1) order.push("listener");
    });
    const dispose = autorun(() => {
      if (node.result.value === 1) {
        order.push("reaction");
        throw failure;
      }
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    configure({ disableErrorBoundaries: true });
    try {
      const completion =
        operation === "unsafeUpdate"
          ? harness.runtime
              .submit({
                _tag: "GraphUnsafeUpdateNode",
                request: {
                  nodeId: handle.nodeId,
                  recipe: (value) => {
                    (value as Counter).result.value = 1;
                  },
                },
              })
              .then((submission) => {
                if (submission._tag !== "GraphUnsafeNodeUpdateCompleted")
                  throw new Error("Expected an unsafe update completion");
                return submission.result;
              })
          : operation === "action"
            ? handle.actions.replace()
            : handle.refresh();
      // A watchdog detects the historical missing-resume bug; it does not
      // synchronize the commit or delay a successful operation.
      const outcome = await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("Committed operation did not resume")),
            1000
          );
        }),
      ]);
      order.push("caller");
      expect(outcome).toMatchObject({ _tag: "Success" });
      expect(node.result.value).toBe(1);
      expect(harness.readReady(handle).result).toBe(node.result);
      expect(handle.read()).toMatchObject({ operationFailure: undefined });
      expect(order.indexOf("reaction")).toBeLessThan(order.indexOf("listener"));
      expect(order.indexOf("listener")).toBeLessThan(order.indexOf("caller"));
      const failures = (await harness.runtime.query({ _tag: "RuntimeEvents" })).events
        .map((record) => record.event)
        .filter((event) => event._tag === "RuntimeObserverFailureObserved");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ eventTag: "GraphNodeChanged", cause: failure });
    } finally {
      clearTimeout(watchdog);
      dispose();
      unsubscribe();
      configure({ disableErrorBoundaries: false });
      _resetGlobalState();
      await harness.teardown();
    }
  });
}
