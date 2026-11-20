import { afterEach, describe, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import {
  createDeferred,
  createFrondTestHarness,
  type FrondTestHarness,
} from "@frondruntime/core/testing";
import { Effect } from "effect";
import { autorun, reaction } from "mobx";

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

type TransportSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly region: string };
  readonly key: Frond.Key.Structure<{ readonly region: string }>;
  readonly result: { readonly region: string };
}>;
class TransportNode extends Frond.NodeBase<TransportSpec> {
  static readonly spec = Frond.serviceSpec.async<TransportSpec>({
    tag: Frond.tag("compat/mobx/transport"),
    key: (args) => Frond.Key.structure(args),
    acquire: Frond.Driver.Acquire((context) => ({ region: context.args.region })),
  });
}

type ProfileShape = {
  readonly args: { readonly region: string };
  readonly deps: { readonly transport: Frond.Dep<typeof TransportNode> };
  readonly result: { value: string };
  readonly actions: { readonly write: Frond.ActionContract<string, string> };
};

function createScenario(mode: "async" | "effect") {
  const acquiring = createDeferred<void>();
  const acquireGate = createDeferred<void>();
  const acting = createDeferred<void>();
  const actionGate = createDeferred<void>();
  const harness = createHarness();
  type AsyncProfileSpec = Frond.NodeSpec<ProfileShape & { readonly mode: "async" }>;
  class AsyncProfileNode extends Frond.NodeBase<AsyncProfileSpec> {
    static readonly spec = Frond.resourceSpec.async<AsyncProfileSpec>({
      tag: Frond.tag("compat/mobx/async-profile"),
      key: () => Frond.Key.singleton(),
      dependencies: Frond.dependencies(() => ({
        transport: Frond.dep(TransportNode, { region: "east" }),
      })),
      acquire: Frond.Driver.Acquire(async () => {
        acquiring.resolve();
        await acquireGate.promise;
        return { value: "acquired" };
      }),
      refresh: Frond.Driver.Refresh((context) => {
        context.setResult({ value: "refreshed" });
      }),
      actions: {
        write: Frond.Driver.Action(async (context, value) => {
          acting.resolve();
          await actionGate.promise;
          context.setResult({ value });
          return `receipt:${value}`;
        }),
      },
    });
  }
  type EffectProfileSpec = Frond.NodeSpec<ProfileShape & { readonly mode: "effect" }>;
  // effect-mode: characterize observable state across both released driver modes — authorized by this task.
  class EffectProfileNode extends Frond.NodeBase<EffectProfileSpec> {
    static readonly spec = Frond.resourceSpec.effect<EffectProfileSpec>({
      tag: Frond.tag("compat/mobx/effect-profile"),
      key: () => Frond.Key.singleton(),
      dependencies: Frond.dependencies(() => ({
        transport: Frond.dep(TransportNode, { region: "east" }),
      })),
      acquire: Frond.Driver.Acquire(() =>
        Effect.gen(function* () {
          acquiring.resolve();
          yield* Effect.promise(() => acquireGate.promise);
          return { value: "acquired" };
        })
      ),
      refresh: Frond.Driver.Refresh((context) => context.setResult({ value: "refreshed" })),
      actions: {
        write: Frond.Driver.Action((context, value) =>
          Effect.gen(function* () {
            acting.resolve();
            yield* Effect.promise(() => actionGate.promise);
            yield* context.setResult({ value });
            return `receipt:${value}`;
          })
        ),
      },
    });
  }
  // Both branches expose the same MobX projection contract; the authored action mode differs.
  const projection =
    mode === "async"
      ? Frond.MobX.createNode(harness.runtime, AsyncProfileNode, { region: "east" })
      : Frond.MobX.createNode(harness.runtime, EffectProfileNode, { region: "east" });
  disposers.push(() => projection.dispose());
  return { harness, projection, acquiring, acquireGate, acting, actionGate };
}

function distinct(states: ReadonlyArray<string>) {
  return states.filter((state, index) => index === 0 || state !== states[index - 1]);
}

function boot(scenario: ReturnType<typeof createScenario>) {
  const read = scenario.projection.handle.boot();
  if (read._tag !== "Pending") throw new Error("Expected a boot attempt");
  return read.attempt;
}

function expectReadyFields(
  scenario: ReturnType<typeof createScenario>,
  value: string,
  region = "east"
) {
  const { projection } = scenario;
  expect(projection.nodeId).toBe(projection.handle.nodeId);
  expect(projection.args).toEqual({ region });
  expect(projection.node.args).toEqual({ region });
  expect(projection.node.deps.transport.result).toEqual({ region: "east" });
  expect(projection.result).toEqual({ value });
  expect(projection.node.result).toEqual({ value });
  expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
  expect(projection.operation).toEqual({ _tag: "Idle" });
  expect(projection.busy).toBe(false);
  expect(projection.operationFailure).toBeUndefined();
  expect(projection.failure).toBeUndefined();
  expect(projection.resultValidity).toMatchObject({ _tag: "Current" });
  expect(projection.snapshot).toMatchObject({
    _tag: "Ready",
    nodeId: projection.nodeId,
    result: { value },
    node: projection.node,
    status: projection.status,
    operation: projection.operation,
    resultValidity: projection.resultValidity,
  });
}

describe("0.5 MobX compatibility", () => {
  for (const mode of ["async", "effect"] as const) {
    test(`${mode} MobX fields are fresh when readiness, actions, refresh, and argument updates resolve`, async () => {
      const scenario = createScenario(mode);
      const { projection, acquireGate, actionGate } = scenario;
      acquireGate.resolve();
      actionGate.resolve();
      await projection.ensureReady();
      expectReadyFields(scenario, "acquired");
      await projection.ensure();
      expectReadyFields(scenario, "acquired");
      const authoredAction = projection.node.actions.write("authored");
      expect(
        await (Effect.isEffect(authoredAction)
          ? Frond.unwrapEffect(authoredAction)
          : authoredAction)
      ).toBe("receipt:authored");
      expectReadyFields(scenario, "authored");
      expect(await projection.runAction("write", "changed")).toMatchObject({
        _tag: "Success",
        value: "receipt:changed",
      });
      expectReadyFields(scenario, "changed");
      expect(await projection.refresh()).toEqual({
        _tag: "Success",
        nodeId: projection.nodeId,
        value: { value: "refreshed" },
      });
      expectReadyFields(scenario, "refreshed");
      await projection.handle.ensureReady();
      expectReadyFields(scenario, "refreshed");
      expect(await projection.handle.updateArgs({ region: "west" })).toMatchObject({
        _tag: "Success",
      });
      expectReadyFields(scenario, "refreshed", "west");
    });

    test(`${mode} boot attempts expose fresh MobX fields when the awaited attempt resolves`, async () => {
      const scenario = createScenario(mode);
      const { projection, acquiring, acquireGate } = scenario;
      const boot = projection.handle.boot();
      if (boot._tag !== "Pending") throw new Error("Expected a boot attempt");
      await acquiring.promise;
      acquireGate.resolve();
      expect(await boot.attempt).toMatchObject({ _tag: "Ready" });
      expectReadyFields(scenario, "acquired");
    });

    test(`${mode} reactions observe pending then ready and busy then idle across driver gates`, async () => {
      const { projection, acquiring, acquireGate, acting, actionGate } = createScenario(mode);
      const readiness: string[] = [];
      const operation: string[] = [];
      const pending = createDeferred<void>();
      const busy = createDeferred<void>();
      disposers.push(
        autorun(() => {
          const status = projection.status;
          const state = status._tag === "Wired" ? status.run._tag : status._tag;
          readiness.push(state);
          if (state === "Pending") pending.resolve();
        })
      );
      disposers.push(
        reaction(
          () => projection.busy,
          (value) => {
            operation.push(value ? "busy" : "idle");
            if (value) busy.resolve();
          },
          { fireImmediately: true }
        )
      );
      const ready = projection.ensureReady();
      await acquiring.promise;
      await pending.promise;
      expect(projection.result).toBeUndefined();
      acquireGate.resolve();
      await ready;
      const action = projection.runAction("write", "changed");
      await acting.promise;
      await busy.promise;
      expect(projection.result).toEqual({ value: "acquired" });
      actionGate.resolve();
      expect(await action).toMatchObject({ _tag: "Success", value: "receipt:changed" });
      expect(distinct(readiness)).toEqual(["Unwired", "Pending", "Ready"]);
      expect(distinct(operation)).toEqual(["idle", "busy", "idle"]);
    });
  }

  for (const operation of ["action", "refresh", "boot"] as const) {
    test(`${operation} started inside a MobX reaction settles with the committed result`, async () => {
      const scenario = createScenario("async");
      const { projection, acquireGate, actionGate } = scenario;
      acquireGate.resolve();
      actionGate.resolve();
      const completed = createDeferred<unknown>();
      if (operation !== "boot") await projection.ensureReady();
      const trigger = createDeferred<void>();
      disposers.push(
        reaction(
          () => projection.result?.value ?? "missing",
          (value) => {
            if (operation === "boot" ? value !== "missing" : value !== "trigger") return;
            const pending =
              operation === "action"
                ? projection.runAction("write", "reaction")
                : operation === "refresh"
                  ? projection.refresh()
                  : boot(scenario);
            void pending.then(completed.resolve, completed.reject);
            trigger.resolve();
          },
          { fireImmediately: operation === "boot" }
        )
      );
      if (operation !== "boot") await projection.runAction("write", "trigger");
      await trigger.promise;
      await completed.promise;
      expectReadyFields(
        scenario,
        operation === "action" ? "reaction" : operation === "refresh" ? "refreshed" : "acquired"
      );
    });
  }

  for (const operation of ["action", "refresh", "boot"] as const) {
    test(`${operation} started inside a runtime listener settles without blocking event delivery`, async () => {
      const scenario = createScenario("async");
      const { projection, harness, acquireGate, actionGate } = scenario;
      acquireGate.resolve();
      actionGate.resolve();
      const completed = createDeferred<unknown>();
      if (operation !== "boot") await projection.ensureReady();
      let submitted = false;
      const subscription = harness.runtime.observe((record) => {
        const event = record.event;
        const matches =
          operation === "boot"
            ? event._tag === "RuntimeSignalPublished"
            : event._tag === "GraphActionSucceeded" &&
              event.nodeId === projection.nodeId &&
              event.input === "trigger";
        if (!matches || submitted) return;
        submitted = true;
        const pending =
          operation === "action"
            ? projection.runAction("write", "listener")
            : operation === "refresh"
              ? projection.refresh()
              : boot(scenario);
        void pending.then(completed.resolve, completed.reject);
      });
      disposers.push(() => subscription.unsubscribe());
      if (operation === "boot") {
        await harness.runtime.publish(
          Frond.Signals.signal({ channel: Frond.Signals.channel("compat/mobx/boot"), name: "boot" })
        );
      } else await projection.runAction("write", "trigger");
      await completed.promise;
      expectReadyFields(
        scenario,
        operation === "action" ? "listener" : operation === "refresh" ? "refreshed" : "acquired"
      );
    });
  }

  test("driver hooks can await dependency actions and refreshes and boot an independent node", async () => {
    type ChildSpec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly args: { readonly name: string };
      readonly key: Frond.Key.Structure<{ readonly name: string }>;
      readonly result: { value: string };
      readonly actions: { readonly write: Frond.ActionContract<string, string> };
    }>;
    class ChildNode extends Frond.NodeBase<ChildSpec> {
      static readonly spec = Frond.resourceSpec.async<ChildSpec>({
        tag: Frond.tag("compat/mobx/reentrant-child"),
        key: (args) => Frond.Key.structure(args),
        acquire: Frond.Driver.Acquire(() => ({ value: "acquired" })),
        refresh: Frond.Driver.Refresh((context) => {
          context.setResult({ value: "refreshed" });
        }),
        actions: {
          write: Frond.Driver.Action((context, value) => {
            context.setResult({ value });
            return value;
          }),
        },
      });
    }
    const harness = createHarness();
    const independent = harness.node(ChildNode, { name: "independent" });
    type ParentSpec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly args: Frond.Args.None;
      readonly deps: { readonly child: Frond.Dep<typeof ChildNode> };
      readonly result: { value: string };
      readonly actions: { readonly write: Frond.ActionContract<void, string> };
    }>;
    class ParentNode extends Frond.NodeBase<ParentSpec> {
      static readonly spec = Frond.facadeSpec.async<ParentSpec>({
        tag: Frond.tag("compat/mobx/reentrant-parent"),
        key: () => Frond.Key.singleton(),
        dependencies: Frond.dependencies(() => ({
          child: Frond.dep(ChildNode, { name: "dependency" }),
        })),
        acquire: Frond.Driver.Acquire(async (context) => {
          const boot = independent.boot();
          if (boot._tag === "Pending") await boot.attempt;
          return { value: await context.deps.child.actions.write("during-acquire") };
        }),
        refresh: Frond.Driver.Refresh(async (context) => {
          await context.refreshDep("child");
          context.setResult({ value: context.deps.child.result.value });
        }),
        actions: {
          write: Frond.Driver.Action(async (context) => {
            const value = await context.deps.child.actions.write("during-action");
            context.setResult({ value });
            return value;
          }),
        },
      });
    }
    const projection = Frond.MobX.createNode(harness.runtime, ParentNode, Frond.Args.none);
    disposers.push(() => projection.dispose());
    await projection.ensureReady();
    expect(projection.result).toEqual({ value: "during-acquire" });
    expect(independent.readReady().result).toEqual({ value: "acquired" });
    expect(await projection.runAction("write")).toMatchObject({
      _tag: "Success",
      value: "during-action",
    });
    expect(projection.node.deps.child.result).toEqual({ value: "during-action" });
    expect(await projection.refresh()).toMatchObject({ _tag: "Success" });
    expect(projection.result).toEqual({ value: "refreshed" });
    expect(projection.node.deps.child.result).toEqual({ value: "refreshed" });
  });

  test("success listeners see committed and authored results before the MobX projection catches up for the caller", async () => {
    const scenario = createScenario("async");
    const { harness, projection, acquireGate, actionGate } = scenario;
    acquireGate.resolve();
    actionGate.resolve();
    await projection.ensureReady();
    const observations: string[] = [];
    disposers.push(
      reaction(
        () => projection.node.result.value,
        (value) => {
          const read = projection.handle.read();
          observations.push(
            `mobx:${value}:${read._tag === "Ready" ? read.result.value : read._tag}`
          );
        }
      )
    );
    disposers.push(
      reaction(
        () => projection.result?.value,
        (value) => observations.push(`projection:${value}`)
      )
    );
    const subscription = harness.runtime.observe((record) => {
      if (record.event._tag !== "GraphActionSucceeded" || record.event.nodeId !== projection.nodeId)
        return;
      const read = projection.handle.read();
      expect(read).toMatchObject({ _tag: "Ready", result: { value: "ordered" } });
      observations.push(`listener:${projection.node.result.value}:${projection.result?.value}`);
    });
    disposers.push(() => subscription.unsubscribe());
    expect(await projection.runAction("write", "ordered")).toMatchObject({
      _tag: "Success",
      value: "receipt:ordered",
    });
    observations.push(`caller:${projection.result?.value}`);
    // 0.5 behavior: the authored MobX write precedes the graph snapshot commit. Success listeners
    // see the committed graph and authored node, but the separate MobX projection is still stale.
    // 0.6 intended change (docs/v06-architecture.md, "Ordering rules": commit, then MobX write,
    // then listeners): the MobX reaction already reads the committed graph. 0.5 recorded
    // "mobx:ordered:acquired".
    expect(distinct(observations)).toEqual([
      "mobx:ordered:ordered",
      "listener:ordered:acquired",
      "projection:ordered",
      "caller:ordered",
    ]);
    expectReadyFields(scenario, "ordered");
  });
});
