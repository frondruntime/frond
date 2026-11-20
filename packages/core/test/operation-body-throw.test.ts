// 0.6 intended change: an action whose driver start throws ends its operation with the invariant failure a refresh already reports, instead of reading busy forever.
import { expect, test } from "bun:test";
import { Cause, Context, Effect, Exit, Tracer } from "effect";
import {
  type ActionContract,
  Driver,
  dependencies,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: { readonly bump: ActionContract<void, number> };
}>;

class Counter extends NodeBase<Spec> {
  static readonly spec = serviceSpec.async<Spec>({
    tag: "operation-body-throw/counter",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => 1),
    refresh: Driver.Refresh((ctx) => {
      ctx.setResult(2);
    }),
    actions: { bump: Driver.Action(() => 3) },
  });
}

const refused = new Error("tracer refused the driver span");

/** A tracer that throws when the graph opens a driver edge span. */
const refusingTracer = Tracer.make({
  span: (options) => {
    if (options.name.endsWith(".driver")) throw refused;
    return {
      _tag: "Span",
      name: options.name,
      spanId: options.name,
      traceId: "operation-body-throw",
      parent: options.parent,
      annotations: Context.empty(),
      status: { _tag: "Started", startTime: options.startTime },
      attributes: new Map(),
      links: [],
      sampled: options.sampled,
      kind: options.kind,
      end: () => {},
      attribute: () => {},
      event: () => {},
      addLinks: () => {},
    };
  },
});

for (const kind of ["action", "refresh"] as const) {
  test(`${kind} whose driver start throws dies to its caller and ends its operation`, async () => {
    const graph = makeInMemoryGraphSystem();
    const request = { spec: Counter, args: {} };
    await Effect.runPromise(graph.ensureReadyNode(request));
    const nodeId = graph.resolveNodeIdSync(request);
    const operation =
      kind === "action"
        ? graph.runAction({ target: { _tag: "NodeId", nodeId }, action: "bump", input: undefined })
        : graph.refreshNode({ target: { _tag: "NodeId", nodeId } });

    const exit = await Effect.runPromise(
      Effect.exit(Effect.withSpan(operation, "caller").pipe(Effect.withTracer(refusingTracer)))
    );

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(refused);
    const lookup = await Effect.runPromise(graph.readNodeSnapshot(nodeId));
    expect(lookup._tag === "Found" && lookup.snapshot).toMatchObject({
      operation: { _tag: "Idle" },
      operationFailure: {
        kind,
        error: {
          _tag: "GraphInvariantViolation",
          invariant: `${kind} operation failed before returning an operation result`,
        },
      },
    });
  }, 2000);
}
