import { expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  type RuntimeSink,
  serviceSpec,
  unwrapEffect,
} from "../src/index";

type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: { readonly stale: ActionContract<void, void> };
}>;

class Resource extends NodeBase<Spec> {
  static readonly spec = serviceSpec.async<Spec>({
    tag: "action-validity-sink/abort",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultValidity: { _tag: "Manual" },
    acquire: Driver.Acquire(() => 0),
    actions: {
      stale: Driver.Action((ctx) => {
        ctx.setResult(1);
        ctx.setResultValidity({ _tag: "Stale", staleAt: 10 });
      }),
    },
  });
}

test("aborting an action interrupts and awaits its parked validity sink", async () => {
  const parked = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let release = () => {};
  let finalized = false;
  let continued = false;
  const sink: RuntimeSink = {
    name: "park-validity",
    handle: ({ event }) => {
      if (event._tag !== "GraphNodeResultValidityChanged" || event.reason !== "manual") {
        return Effect.void;
      }
      return Effect.callback<void>((resume) => {
        release = () => resume(Effect.void);
        parked.resolve();
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            continued = true;
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
            finished.resolve();
          })
        )
      );
    },
  };
  const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [sink] });
  try {
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    const abort = new AbortController();
    const action = unwrapEffect(handle.action("stale", undefined, { signal: abort.signal })).then(
      () => false,
      (cause: unknown) => Cause.isCause(cause) && Cause.hasInterruptsOnly(cause)
    );
    await parked.promise;
    expect(handle.read()).toMatchObject({ result: 1, resultValidity: { _tag: "Stale" } });
    abort.abort();
    expect(await action).toBe(true);
    const finalizedAtAbort = finalized;
    release();
    await finished.promise;
    expect({ finalizedAtAbort, continued }).toEqual({ finalizedAtAbort: true, continued: false });
  } finally {
    release();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
