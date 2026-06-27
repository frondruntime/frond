import { describe, expect, test } from "bun:test";
import {
  type ActionContract,
  ActionFailed,
  ActionProfileNode,
  Deferred,
  type Dep,
  DependencyFailures,
  Driver,
  DriverOperationTimedOut,
  dep,
  dependencies,
  Effect,
  EffectBoundaryFailed,
  GraphInvariantViolation,
  Key,
  type MutableProfile,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  serviceSpec,
} from "./graphTestFixtures";

describe("graph actions", () => {
  test("async action succeeds and patches stored result", async () => {
    const graph = makeInMemoryGraphSystem();

    const result = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionProfileNode, args: {} },
        },
        action: "updateTimezone",
        input: { timezone: "CET" },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const profile = snapshot.nodes.find((node) => node.tag === "resources/action-profile");

    expect(result).toMatchObject({
      _tag: "Success",
      value: { timezone: "CET" },
    });
    expect(profile?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(profile?.result).toEqual({ name: "transport", timezone: "CET" });
  });

  test("action facade exposes only declared actions and is not thenable", async () => {
    const graph = makeInMemoryGraphSystem();

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ActionProfileNode, args: {} })
    );

    if (handle._tag !== "Ready") {
      throw new Error(`Expected a ready node, got ${handle._tag}.`);
    }

    const node = handle.node as ActionProfileNode;
    const facade = node.actions as Record<string, unknown>;

    // Protocol trap names must not produce phantom action dispatchers. A callable
    // "then" makes the facade a thenable, so awaiting it would never settle and
    // would dispatch a phantom "then" action whose failure becomes an unhandled
    // rejection.
    expect(facade.then).toBeUndefined();
    expect(facade.catch).toBeUndefined();
    expect(facade.finally).toBeUndefined();
    expect(facade.toJSON).toBeUndefined();
    expect(facade.constructor).toBeUndefined();
    expect(facade.somethingUndeclared).toBeUndefined();

    // Awaiting the facade must settle instead of hanging on thenable assimilation.
    const settled = await Promise.race([
      Promise.resolve(node.actions).then(() => "settled" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250)),
    ]);
    expect(settled).toBe("settled");

    // JSON serialization must not dispatch a phantom "toJSON" action.
    expect(() => JSON.stringify(node.actions)).not.toThrow();

    // Declared action contracts still dispatch through the driver.
    expect("updateTimezone" in node.actions).toBe(true);
    expect("then" in facade).toBe(false);
    await expect(node.actions.updateTimezone({ timezone: "CET" })).resolves.toEqual({
      timezone: "CET",
    });
  });

  test("action failure returns failure without changing ready node state", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ActionProfileNode, args: {} }));
    const result = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionProfileNode, args: {} },
        },
        action: "failTimezone",
        input: { timezone: "BAD" },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const profile = snapshot.nodes.find((node) => node.tag === "resources/action-profile");

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.error : undefined).toBeInstanceOf(ActionFailed);
    expect(profile?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(profile?.failure).toBeUndefined();
    expect(profile?.operation).toEqual({ _tag: "Idle" });
    expect(profile?.operationFailure).toMatchObject({
      kind: "action",
      error: { _tag: "ActionFailed", action: "failTimezone" },
    });
    expect(profile?.result).toEqual({ name: "transport", timezone: "UTC" });
  });

  test("patching an empty result fails with structured graph context", async () => {
    type EmptyPatchSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: undefined;
      readonly actions: {
        readonly patch: ActionContract<void, void>;
      };
    }>;

    class EmptyPatchNode extends NodeBase<EmptyPatchSpec> {
      static readonly spec = resourceSpec<EmptyPatchSpec>({
        tag: "resources/empty-patch",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<EmptyPatchSpec>({
          acquire: Driver.Acquire(() => Effect.succeed(undefined)),
          actions: {
            patch: Driver.Action((ctx) => ctx.patchResult(() => undefined)),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const result = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: EmptyPatchNode, args: {} },
        },
        action: "patch",
        input: undefined,
      })
    );

    expect(result._tag).toBe("Failure");

    if (result._tag !== "Failure") {
      throw new Error("Expected patch action failure.");
    }

    expect(result.error).toMatchObject({
      _tag: "ActionFailed",
      cause: {
        _tag: "DriverPromiseFailed",
        operation: "patchResult",
      },
    });
    expect(result.error.cause).toMatchObject({
      cause: {
        _tag: "GraphInvariantViolation",
        invariant: "driver patchResult requires an existing graph result",
      },
    });
    expect(result.error.cause.cause).toBeInstanceOf(GraphInvariantViolation);
  });

  test("action defects preserve Effect cause in action failure", async () => {
    const cause = new TypeError("action died");
    type DefectActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
      readonly actions: {
        readonly crash: ActionContract<void, never>;
      };
    }>;

    class DefectActionNode extends NodeBase<DefectActionSpec> {
      static readonly spec = resourceSpec<DefectActionSpec>({
        tag: "resources/action-defect",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DefectActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
          actions: {
            crash: Driver.Action(() => Effect.die(cause)),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: DefectActionNode, args: {} }));
    const result = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: DefectActionNode, args: {} },
        },
        action: "crash",
        input: undefined,
      })
    );
    const failure = result._tag === "Failure" ? result.error : undefined;
    const boundary = failure instanceof ActionFailed ? failure.cause : undefined;

    expect(failure).toBeInstanceOf(ActionFailed);
    expect(boundary).toBeInstanceOf(EffectBoundaryFailed);
    expect((boundary as EffectBoundaryFailed | undefined)?.boundary).toBe("driver-action");
    expect((boundary as EffectBoundaryFailed | undefined)?.cause).toBe(cause);
  });

  test("action defect retains staged operation disposer for later release", async () => {
    const cause = new TypeError("action disposer defect");
    let disposed = 0;
    type DisposingActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
      readonly actions: {
        readonly crash: ActionContract<void, never>;
      };
    }>;

    class DisposingActionNode extends NodeBase<DisposingActionSpec> {
      static readonly spec = resourceSpec<DisposingActionSpec>({
        tag: "resources/action-defect-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DisposingActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
          actions: {
            crash: Driver.Action((ctx) =>
              Effect.gen(function* () {
                ctx.disposers.add(() => {
                  disposed += 1;
                });
                return yield* Effect.die(cause);
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DisposingActionNode, args: {} })
    );

    const result = await Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeId", nodeId: handle.nodeId },
        action: "crash",
        input: undefined,
      })
    );

    expect(result._tag).toBe("Failure");
    expect(disposed).toBe(0);

    await Effect.runPromise(graph.releaseNode(handle.nodeId));

    expect(disposed).toBe(1);
  });

  test("missing action returns ActionFailed", async () => {
    const graph = makeInMemoryGraphSystem();

    const result = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionProfileNode, args: {} },
        },
        action: "missing",
        input: undefined,
      })
    );

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.error : undefined).toMatchObject({
      _tag: "ActionFailed",
      action: "missing",
      cause: {
        _tag: "GraphInvariantViolation",
        invariant: "requested action must exist on the node driver",
      },
    });
  });

  test("action request by node request ensures readiness before running", async () => {
    const graph = makeInMemoryGraphSystem();

    const result = await Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ActionProfileNode, args: {} },
        },
        action: "updateTimezone",
        input: { timezone: "EET" },
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const tags = snapshot.nodes.map((node) => node.tag).sort();

    expect(result._tag).toBe("Success");
    expect(tags).toEqual(["resources/action-profile", "services/transport"]);
  });

  test("action submitted during pending acquire waits and then runs", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<MutableProfile>());
    type SlowActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: MutableProfile;
      readonly actions: {
        readonly updateTimezone: ActionContract<
          { readonly timezone: string },
          { readonly timezone: string }
        >;
      };
    }>;

    class SlowActionNode extends NodeBase<SlowActionSpec> {
      static readonly spec = resourceSpec<SlowActionSpec>({
        tag: "resources/slow-action-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowActionSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
          actions: {
            updateTimezone: Driver.Action((ctx, parsedInput) =>
              Effect.gen(function* () {
                yield* ctx.patchResult((current) => {
                  current.timezone = parsedInput.timezone;
                });
                return parsedInput;
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const ready = Effect.runPromise(graph.ensureReadyNode({ spec: SlowActionNode, args: {} }));
    await Effect.runPromise(Deferred.await(started));
    const action = Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: SlowActionNode, args: {} },
        },
        action: "updateTimezone",
        input: { timezone: "CET" },
      })
    );

    await Effect.runPromise(Deferred.succeed(gate, { name: "Ada", timezone: "UTC" }));
    await ready;
    const result = await action;
    const snapshot = await Effect.runPromise(graph.snapshot());
    const profile = snapshot.nodes.find((node) => node.tag === "resources/slow-action-profile");

    expect(result).toMatchObject({ _tag: "Success", value: { timezone: "CET" } });
    expect(profile?.result).toEqual({ name: "Ada", timezone: "CET" });
  });

  test("two actions on the same node run in submission order", async () => {
    const firstStarted = await Effect.runPromise(Deferred.make<void>());
    const firstGate = await Effect.runPromise(Deferred.make<void>());
    let activeActions = 0;
    let overlapped = false;
    const order: Array<string> = [];
    type OrderedSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { value: string };
      readonly actions: {
        readonly setValue: ActionContract<{ readonly value: string }, string>;
      };
    }>;

    class OrderedNode extends NodeBase<OrderedSpec> {
      static readonly spec = resourceSpec<OrderedSpec>({
        tag: "resources/ordered-actions",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OrderedSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "initial" })),
          actions: {
            setValue: Driver.Action((ctx, input) =>
              Effect.gen(function* () {
                activeActions += 1;
                overlapped = overlapped || activeActions > 1;
                order.push(input.value);

                if (input.value === "first") {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(firstGate);
                }

                yield* ctx.patchResult((current) => {
                  current.value = input.value;
                });
                activeActions -= 1;
                return input.value;
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const request = {
      target: {
        _tag: "NodeRequest" as const,
        request: { spec: OrderedNode, args: {} },
      },
      action: "setValue",
    };

    const first = Effect.runPromise(graph.runAction({ ...request, input: { value: "first" } }));
    await Effect.runPromise(Deferred.await(firstStarted));
    const second = Effect.runPromise(graph.runAction({ ...request, input: { value: "second" } }));

    await Effect.runPromise(Deferred.succeed(firstGate, undefined));
    await Promise.all([first, second]);
    const snapshot = await Effect.runPromise(graph.snapshot());
    const ordered = snapshot.nodes.find((node) => node.tag === "resources/ordered-actions");

    expect(overlapped).toBe(false);
    expect(order).toEqual(["first", "second"]);
    expect(ordered?.result).toEqual({ value: "second" });
  });

  test("pending action exposes operation state while keeping ready result", async () => {
    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    const actionGate = await Effect.runPromise(Deferred.make<void>());
    type SlowActionOperationSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
      readonly actions: {
        readonly setValue: ActionContract<{ readonly value: string }, void>;
      };
    }>;

    class SlowActionNode extends NodeBase<SlowActionOperationSpec> {
      static readonly spec = resourceSpec<SlowActionOperationSpec>({
        tag: "resources/slow-action-operation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowActionOperationSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          actions: {
            setValue: Driver.Action((ctx, input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(actionStarted, undefined);
                yield* Deferred.await(actionGate);
                yield* ctx.setResult(input);
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: SlowActionNode, args: {} }));
    const action = Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: SlowActionNode, args: {} },
        },
        action: "setValue",
        input: { value: "fresh" },
      })
    );
    await Effect.runPromise(Deferred.await(actionStarted));
    const pendingSnapshot = await Effect.runPromise(graph.snapshot());
    const pendingNode = pendingSnapshot.nodes.find(
      (entry) => entry.tag === "resources/slow-action-operation"
    );

    expect(pendingNode?.result).toEqual({ value: "stable" });
    expect(pendingNode?.operation).toMatchObject({
      _tag: "Running",
      kind: "action",
      action: "setValue",
    });

    await Effect.runPromise(Deferred.succeed(actionGate, undefined));
    await action;
    const readySnapshot = await Effect.runPromise(graph.snapshot());
    const readyNode = readySnapshot.nodes.find(
      (entry) => entry.tag === "resources/slow-action-operation"
    );

    expect(readyNode?.operation).toEqual({ _tag: "Idle" });
    expect(readyNode?.operationFailure).toBeUndefined();
    expect(readyNode?.result).toEqual({ value: "fresh" });
  });

  test("actions on different node identities can overlap", async () => {
    const firstStarted = await Effect.runPromise(Deferred.make<void>());
    const secondStarted = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<void>());
    type ParallelSpec = NodeSpec<{
      readonly args: { readonly id: string };
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: Record<string, never>;
      readonly result: { readonly id: string };
      readonly actions: {
        readonly wait: ActionContract<{ readonly id: string }, string>;
      };
    }>;

    class ParallelNode extends NodeBase<ParallelSpec> {
      static readonly spec = resourceSpec<ParallelSpec>({
        tag: "resources/parallel-actions",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ParallelSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ id: "ready" })),
          actions: {
            wait: Driver.Action((_ctx, input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(
                  input.id === "first" ? firstStarted : secondStarted,
                  undefined
                );
                yield* Deferred.await(gate);
                return input.id;
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();

    const first = Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ParallelNode, args: { id: "first" } },
        },
        action: "wait",
        input: { id: "first" },
      })
    );
    await Effect.runPromise(Deferred.await(firstStarted));
    const second = Effect.runPromise(
      graph.runAction({
        target: {
          _tag: "NodeRequest",
          request: { spec: ParallelNode, args: { id: "second" } },
        },
        action: "wait",
        input: { id: "second" },
      })
    );

    await Effect.runPromise(Deferred.await(secondStarted).pipe(Effect.timeout("100 millis")));
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ _tag: "Success", value: "first" });
    expect(secondResult).toMatchObject({ _tag: "Success", value: "second" });
  });

  test("action after release re-acquires before running", async () => {
    let acquireCount = 0;
    type ReacquireSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { count: number };
      readonly actions: {
        readonly increment: ActionContract<void, void>;
      };
    }>;

    class ReacquireNode extends NodeBase<ReacquireSpec> {
      static readonly spec = resourceSpec<ReacquireSpec>({
        tag: "resources/reacquire-action",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ReacquireSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquireCount += 1;
              return { count: 0 };
            })
          ),
          actions: {
            increment: Driver.Action((ctx) =>
              Effect.gen(function* () {
                yield* ctx.patchResult((current) => {
                  current.count += 1;
                });
              })
            ),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ReacquireNode, args: {} })
    );

    await Effect.runPromise(graph.releaseNode(handle.nodeId));
    const result = await Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeId", nodeId: handle.nodeId },
        action: "increment",
        input: undefined,
      })
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/reacquire-action");

    expect(result._tag).toBe("Success");
    expect(acquireCount).toBe(2);
    expect(node?.result).toEqual({ count: 1 });
  });

  test("action dependency value collection aggregates multiple dependency failures", async () => {
    type LeftSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LeftNode extends NodeBase<LeftSpec> {
      static readonly spec = serviceSpec<LeftSpec>({
        tag: "services/action-aggregate-left",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LeftSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("left")),
        }),
      });
    }

    type RightSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class RightNode extends NodeBase<RightSpec> {
      static readonly spec = serviceSpec<RightSpec>({
        tag: "services/action-aggregate-right",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RightSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("right")),
        }),
      });
    }

    type ParentSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly left: Dep<typeof LeftNode>;
        readonly right: Dep<typeof RightNode>;
      };
      readonly result: { readonly value: string };
      readonly actions: {
        readonly noop: ActionContract<void, string>;
      };
    }>;

    class ParentNode extends NodeBase<ParentSpec> {
      static readonly spec = resourceSpec<ParentSpec>({
        tag: "resources/action-aggregate-parent",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          left: dep(LeftNode, {}),
          right: dep(RightNode, {}),
        })),
        driver: Driver.Effect<ParentSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
          actions: {
            noop: Driver.Action(() => Effect.succeed("noop")),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const parent = await Effect.runPromise(graph.ensureReadyNode({ spec: ParentNode, args: {} }));
    const readySnapshot = await Effect.runPromise(graph.snapshot());
    const left = readySnapshot.nodes.find((node) => node.tag === "services/action-aggregate-left");
    const right = readySnapshot.nodes.find(
      (node) => node.tag === "services/action-aggregate-right"
    );

    if (left === undefined || right === undefined) {
      throw new Error("Expected dependency nodes to be planned.");
    }

    await Effect.runPromise(graph.releaseNode(left.nodeId));
    await Effect.runPromise(graph.releaseNode(right.nodeId));
    const result = await Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeId", nodeId: parent.nodeId },
        action: "noop",
        input: undefined,
      })
    );
    const failure = result._tag === "Failure" ? result.error : undefined;
    const aggregate = failure instanceof ActionFailed ? failure.cause : undefined;

    expect(result._tag).toBe("Failure");
    expect(failure).toBeInstanceOf(ActionFailed);
    expect(aggregate).toBeInstanceOf(DependencyFailures);

    if (!(aggregate instanceof DependencyFailures)) {
      throw new Error("Expected aggregate dependency failure.");
    }

    expect(aggregate.failures).toHaveLength(2);
    expect(aggregate.failures.map((entry) => entry.dependency).sort()).toEqual(["left", "right"]);
  });

  test("action timeout returns failure without changing readiness", async () => {
    type TimeoutActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
      readonly actions: {
        readonly hang: ActionContract<void, never>;
      };
    }>;

    class TimeoutActionNode extends NodeBase<TimeoutActionSpec> {
      static readonly spec = resourceSpec<TimeoutActionSpec>({
        tag: "resources/action-timeout",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<TimeoutActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
          actions: {
            hang: Driver.Action(() => Effect.never),
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { action: 20 },
    });

    await Effect.runPromise(graph.ensureReadyNode({ spec: TimeoutActionNode, args: {} }));
    const result = await Effect.runPromise(
      graph
        .runAction({
          target: {
            _tag: "NodeRequest",
            request: { spec: TimeoutActionNode, args: {} },
          },
          action: "hang",
          input: undefined,
        })
        .pipe(Effect.timeout("200 millis"))
    );
    const snapshot = await Effect.runPromise(graph.snapshot());
    const node = snapshot.nodes.find((entry) => entry.tag === "resources/action-timeout");
    const error = result._tag === "Failure" ? result.error : undefined;

    expect(result._tag).toBe("Failure");
    expect(error).toBeInstanceOf(ActionFailed);
    expect(error?.cause).toBeInstanceOf(DriverOperationTimedOut);
    expect(error?.cause).toMatchObject({
      cancellation: { _tag: "TimedOut", detail: "20ms" },
    });
    expect(node?.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(node?.result).toEqual({ value: "stable" });
    expect(node?.operationFailure).toMatchObject({
      kind: "action",
      error: { _tag: "ActionFailed", action: "hang" },
    });
  });
});
