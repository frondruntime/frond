import { expect, test } from "bun:test";
import { Fiber } from "effect";
import {
  type ActionContract,
  Deferred,
  Driver,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "./graphTestFixtures";

test("interrupted in-flight action settles the operation phase for later work", async () => {
  const started = await Effect.runPromise(Deferred.make<void>());
  type ReproSpec = NodeSpec<{
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: { value: string };
    readonly actions: {
      readonly wait: ActionContract<void, string>;
      readonly quick: ActionContract<void, string>;
    };
  }>;

  class ReproNode extends NodeBase<ReproSpec, "effect"> {
    static readonly spec = resourceSpec.effect<ReproSpec>({
      tag: "resources/interrupt-phase-repro",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
      actions: {
        wait: Driver.Action(() =>
          Deferred.succeed(started, undefined).pipe(Effect.flatMap(() => Effect.never))
        ),
        quick: Driver.Action(() => Effect.succeed("quick")),
      },
    });
  }

  const graph = makeInMemoryGraphSystem();
  await Effect.runPromise(graph.ensureReadyNode({ spec: ReproNode, args: {} }));

  const request = (action: string) => ({
    target: { _tag: "NodeRequest" as const, request: { spec: ReproNode, args: {} } },
    action,
    input: undefined,
  });

  const fiber = Effect.runFork(graph.runAction(request("wait")));
  await Effect.runPromise(Deferred.await(started));
  await Effect.runPromise(Fiber.interrupt(fiber));

  const quick = await Effect.runPromise(graph.runAction(request("quick")));
  const snapshot = await Effect.runPromise(graph.snapshot());
  const node = snapshot.nodes.find((entry) => entry.tag === "resources/interrupt-phase-repro");

  expect(quick).toMatchObject({ _tag: "Success", value: "quick" });
  expect(node?.operation).toEqual({ _tag: "Idle" });
  expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
});
