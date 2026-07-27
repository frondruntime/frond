import { describe, expect, test } from "bun:test";
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

type VoidJoinSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
  readonly actions: {
    readonly expire: ActionContract<void, string>;
  };
}>;

function makeVoidJoinRequest(spec: unknown) {
  return {
    target: {
      _tag: "NodeRequest" as const,
      request: { spec, args: {} },
    },
    action: "expire",
    input: undefined,
  };
}

describe("void-input join admission", () => {
  test("N concurrent invocations run the driver once and all resolve with its result", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<void>());
    let runs = 0;

    class SessionNode extends NodeBase<VoidJoinSpec> {
      static readonly spec = resourceSpec.effect<VoidJoinSpec>({
        tag: "resources/void-join-shared",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        actions: {
          expire: Driver.Action(
            (_ctx, _input) =>
              Effect.gen(function* () {
                runs += 1;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(gate);
                return `expired:${runs}`;
              }),
            { admission: "join" }
          ),
        },
      });
    }

    const graph = makeInMemoryGraphSystem();
    const request = makeVoidJoinRequest(SessionNode);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* graph.ensureReadyNode({ spec: SessionNode, args: {} });
        // The N-concurrent-401s shape: all three callers are in flight before
        // the shared run is released.
        const first = yield* graph.runAction(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* graph.runAction(request).pipe(Effect.forkChild);
        const third = yield* graph.runAction(request).pipe(Effect.forkChild);
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(gate, undefined);

        const firstResult = yield* Fiber.join(first);
        const secondResult = yield* Fiber.join(second);
        const thirdResult = yield* Fiber.join(third);

        expect(firstResult).toMatchObject({ _tag: "Success", value: "expired:1" });
        expect(secondResult).toMatchObject({ _tag: "Success", value: "expired:1" });
        expect(thirdResult).toMatchObject({ _tag: "Success", value: "expired:1" });
        expect(runs).toBe(1);
      })
    );
  });

  test("an invocation after settlement starts a fresh run", async () => {
    let runs = 0;

    class SessionNode extends NodeBase<VoidJoinSpec> {
      static readonly spec = resourceSpec.effect<VoidJoinSpec>({
        tag: "resources/void-join-settled",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        actions: {
          expire: Driver.Action(
            (_ctx, _input) =>
              Effect.sync(() => {
                runs += 1;
                return `expired:${runs}`;
              }),
            { admission: "join" }
          ),
        },
      });
    }

    const graph = makeInMemoryGraphSystem();
    const request = makeVoidJoinRequest(SessionNode);

    const first = await Effect.runPromise(graph.runAction(request));
    const second = await Effect.runPromise(graph.runAction(request));

    expect(first).toMatchObject({ _tag: "Success", value: "expired:1" });
    expect(second).toMatchObject({ _tag: "Success", value: "expired:2" });
    expect(runs).toBe(2);
  });

  test("interrupting one joiner does not abort the shared run", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<void>());
    let runs = 0;
    let settled = 0;

    class SessionNode extends NodeBase<VoidJoinSpec> {
      static readonly spec = resourceSpec.effect<VoidJoinSpec>({
        tag: "resources/void-join-interrupt",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        actions: {
          expire: Driver.Action(
            (_ctx, _input) =>
              Effect.gen(function* () {
                runs += 1;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(gate);
                settled += 1;
                return `expired:${runs}`;
              }),
            { admission: "join" }
          ),
        },
      });
    }

    const graph = makeInMemoryGraphSystem();
    const request = makeVoidJoinRequest(SessionNode);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* graph.ensureReadyNode({ spec: SessionNode, args: {} });
        const first = yield* graph.runAction(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const joiner = yield* graph.runAction(request).pipe(Effect.forkDetach);
        yield* Effect.sleep("50 millis");
        yield* Fiber.interrupt(joiner);
        yield* Deferred.succeed(gate, undefined);
        const firstResult = yield* Fiber.join(first).pipe(Effect.timeout("500 millis"));

        expect(firstResult).toMatchObject({ _tag: "Success", value: "expired:1" });
        expect(runs).toBe(1);
        expect(settled).toBe(1);
      })
    );
  });

  test("a void action without declared admission keeps the queue default", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<void>());
    let runs = 0;

    class SessionNode extends NodeBase<VoidJoinSpec> {
      static readonly spec = resourceSpec.effect<VoidJoinSpec>({
        tag: "resources/void-default-queue",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        actions: {
          expire: Driver.Action((_ctx, _input) =>
            Effect.gen(function* () {
              runs += 1;
              if (runs === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(gate);
              }
              return `expired:${runs}`;
            })
          ),
        },
      });
    }

    const graph = makeInMemoryGraphSystem();
    const request = makeVoidJoinRequest(SessionNode);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* graph.ensureReadyNode({ spec: SessionNode, args: {} });
        const first = yield* graph.runAction(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* graph.runAction(request).pipe(Effect.forkChild);
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(gate, undefined);

        const firstResult = yield* Fiber.join(first);
        const secondResult = yield* Fiber.join(second);

        // Queue admission serializes per node but never dedupes: both callers
        // execute the driver, so the run count is 2 (not joined, not rejected).
        expect(firstResult).toMatchObject({ _tag: "Success", value: "expired:1" });
        expect(secondResult).toMatchObject({ _tag: "Success", value: "expired:2" });
        expect(runs).toBe(2);
      })
    );
  });
});
