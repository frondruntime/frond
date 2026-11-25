import { afterEach, describe, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import {
  createDeferred,
  createFrondTestHarness,
  type FrondTestHarness,
} from "@frondruntime/core/testing";
import { Effect } from "effect";
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
  // Both handles expose the same read contract; authored action modes differ.
  const handle =
    mode === "async"
      ? harness.node(AsyncProfileNode, { region: "east" })
      : harness.node(EffectProfileNode, { region: "east" });
  return { harness, handle, acquiring, acquireGate, acting, actionGate };
}

function distinct(states: ReadonlyArray<string>) {
  return states.filter((state, index) => index === 0 || state !== states[index - 1]);
}

function boot(scenario: ReturnType<typeof createScenario>) {
  const read = scenario.handle.boot();
  if (read._tag !== "Pending") throw new Error("Expected a boot attempt");
  return read.attempt;
}

function expectReadyFields(
  scenario: ReturnType<typeof createScenario>,
  value: string,
  region = "east"
) {
  const { handle } = scenario;
  const read = handle.read();
  expect(read._tag).toBe("Ready");
  if (read._tag !== "Ready") throw new Error("Expected a ready node");
  expect(read.node.nodeId).toBe(handle.nodeId);
  expect(handle.args).toEqual({ region });
  expect(read.node.args).toEqual({ region });
  expect(read.node.deps.transport.result).toEqual({ region: "east" });
  expect(read.result).toEqual({ value });
  expect(read.node.result).toBe(read.result);
  expect(read.operation).toEqual({ _tag: "Idle" });
  expect(read.busy).toBe(false);
  expect(read.operationFailure).toBeUndefined();
  expect(read.resultValidity).toMatchObject({ _tag: "Current" });
}

describe("class node and handle compatibility", () => {
  for (const mode of ["async", "effect"] as const) {
    test(`${mode} class node fields are fresh when readiness, actions, refresh, and argument updates resolve`, async () => {
      const scenario = createScenario(mode);
      const { handle, acquireGate, actionGate } = scenario;
      acquireGate.resolve();
      actionGate.resolve();
      await handle.ensureReady();
      expectReadyFields(scenario, "acquired");
      await handle.ensure();
      expectReadyFields(scenario, "acquired");
      const authoredAction = handle.readReady().actions.write("authored");
      expect(
        await (Effect.isEffect(authoredAction)
          ? Frond.unwrapEffect(authoredAction)
          : authoredAction)
      ).toBe("receipt:authored");
      expectReadyFields(scenario, "authored");
      expect(await Frond.unwrapEffect(handle.action("write", "changed"))).toMatchObject({
        _tag: "Success",
        value: "receipt:changed",
      });
      expectReadyFields(scenario, "changed");
      expect(await handle.refresh()).toEqual({
        _tag: "Success",
        nodeId: handle.nodeId,
        value: { value: "refreshed" },
      });
      expectReadyFields(scenario, "refreshed");
      await handle.ensureReady();
      expectReadyFields(scenario, "refreshed");
      expect(await handle.updateArgs({ region: "west" })).toMatchObject({
        _tag: "Success",
      });
      expectReadyFields(scenario, "refreshed", "west");
    });

    test(`${mode} boot attempts expose fresh class node fields when the awaited attempt resolves`, async () => {
      const scenario = createScenario(mode);
      const { handle, acquiring, acquireGate } = scenario;
      const boot = handle.boot();
      if (boot._tag !== "Pending") throw new Error("Expected a boot attempt");
      await acquiring.promise;
      acquireGate.resolve();
      expect(await boot.attempt).toMatchObject({ _tag: "Ready" });
      expectReadyFields(scenario, "acquired");
    });

    test(`${mode} reads expose pending then ready and busy then idle across driver gates`, async () => {
      const { handle, acquiring, acquireGate, acting, actionGate } = createScenario(mode);
      const ready = handle.ensureReady();
      await acquiring.promise;
      expect(handle.read()).toMatchObject({ _tag: "Pending", busy: false });
      acquireGate.resolve();
      await ready;
      const node = handle.readReady();
      const observed = [node.result.value];
      disposers.push(
        reaction(
          () => node.result.value,
          (value) => observed.push(value)
        )
      );
      expect(handle.read()).toMatchObject({ _tag: "Ready", busy: false });
      const action = Frond.unwrapEffect(handle.action("write", "changed"));
      await acting.promise;
      expect(handle.read()).toMatchObject({
        _tag: "Ready",
        busy: true,
        operation: { _tag: "Running", kind: "action" },
        result: { value: "acquired" },
      });
      expect(node.result).toEqual({ value: "acquired" });
      actionGate.resolve();
      expect(await action).toMatchObject({ _tag: "Success", value: "receipt:changed" });
      expect(handle.read()).toMatchObject({ _tag: "Ready", busy: false });
      expect(observed).toEqual(["acquired", "changed"]);
    });
  }

  for (const operation of ["action", "refresh", "boot"] as const) {
    test(`${operation} started inside a MobX reaction settles with the committed result`, async () => {
      const scenario = createScenario("async");
      const { handle, acquireGate, actionGate } = scenario;
      acquireGate.resolve();
      actionGate.resolve();
      const completed = createDeferred<unknown>();
      if (operation !== "boot") await handle.ensureReady();
      const trigger = createDeferred<void>();
      disposers.push(
        reaction(
          () => {
            const read = handle.read();
            return read._tag === "Ready" ? read.node.result.value : "missing";
          },
          (value) => {
            if (operation === "boot" ? value !== "missing" : value !== "trigger") return;
            const pending =
              operation === "action"
                ? Frond.unwrapEffect(handle.action("write", "reaction"))
                : operation === "refresh"
                  ? handle.refresh()
                  : boot(scenario);
            void pending.then(completed.resolve, completed.reject);
            trigger.resolve();
          },
          { fireImmediately: operation === "boot" }
        )
      );
      if (operation !== "boot") await Frond.unwrapEffect(handle.action("write", "trigger"));
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
      const { handle, harness, acquireGate, actionGate } = scenario;
      acquireGate.resolve();
      actionGate.resolve();
      const completed = createDeferred<unknown>();
      if (operation !== "boot") await handle.ensureReady();
      let submitted = false;
      const subscription = harness.runtime.observe((record) => {
        const event = record.event;
        const matches =
          operation === "boot"
            ? event._tag === "RuntimeSignalPublished"
            : event._tag === "GraphActionSucceeded" &&
              event.nodeId === handle.nodeId &&
              event.input === "trigger";
        if (!matches || submitted) return;
        submitted = true;
        const pending =
          operation === "action"
            ? Frond.unwrapEffect(handle.action("write", "listener"))
            : operation === "refresh"
              ? handle.refresh()
              : boot(scenario);
        void pending.then(completed.resolve, completed.reject);
      });
      disposers.push(() => subscription.unsubscribe());
      if (operation === "boot") {
        await harness.runtime.publish(
          Frond.Signals.signal({ channel: Frond.Signals.channel("compat/mobx/boot"), name: "boot" })
        );
      } else await Frond.unwrapEffect(handle.action("write", "trigger"));
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
    const handle = harness.node(ParentNode, Frond.Args.none);
    await handle.ensureReady();
    expect(handle.readReady().result).toEqual({ value: "during-acquire" });
    expect(independent.readReady().result).toEqual({ value: "acquired" });
    expect(await Frond.unwrapEffect(handle.action("write"))).toMatchObject({
      _tag: "Success",
      value: "during-action",
    });
    expect(handle.readReady().deps.child.result).toEqual({ value: "during-action" });
    expect(await handle.refresh()).toMatchObject({ _tag: "Success" });
    expect(handle.readReady().result).toEqual({ value: "refreshed" });
    expect(handle.readReady().deps.child.result).toEqual({ value: "refreshed" });
  });

  test("success listeners and callers see the committed class node result", async () => {
    const scenario = createScenario("async");
    const { harness, handle, acquireGate, actionGate } = scenario;
    acquireGate.resolve();
    actionGate.resolve();
    await handle.ensureReady();
    const observations: string[] = [];
    disposers.push(
      reaction(
        () => handle.readReady().result.value,
        (value) => {
          const read = handle.read();
          observations.push(
            `mobx:${value}:${read._tag === "Ready" ? read.result.value : read._tag}`
          );
        }
      )
    );
    const subscription = harness.runtime.observe((record) => {
      if (record.event._tag !== "GraphActionSucceeded" || record.event.nodeId !== handle.nodeId)
        return;
      const read = handle.read();
      expect(read).toMatchObject({ _tag: "Ready", result: { value: "ordered" } });
      observations.push(`listener:${handle.readReady().result.value}`);
    });
    disposers.push(() => subscription.unsubscribe());
    expect(await Frond.unwrapEffect(handle.action("write", "ordered"))).toMatchObject({
      _tag: "Success",
      value: "receipt:ordered",
    });
    observations.push(`caller:${handle.readReady().result.value}`);
    expect(distinct(observations)).toEqual([
      "mobx:ordered:ordered",
      "listener:ordered",
      "caller:ordered",
    ]);
    expectReadyFields(scenario, "ordered");
  });
});
