import { expect, test } from "bun:test";
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
} from "@frondruntime/core";
import { Cause, Deferred, Effect } from "effect";

type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: { readonly act: ActionContract<void, void> };
}>;

for (const [operation, event] of [
  ["action", "GraphNodeChanged"],
  ["action", "GraphActionSucceeded"],
  ["refresh", "GraphNodeChanged"],
  ["args", "GraphNodeChanged"],
] as const) {
  const cancellation = operation === "action" ? "aborting" : "evicting";
  test(`${cancellation} a settled ${operation} interrupts and awaits its ${event} sink`, async () => {
    const parked = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const finalizing = Deferred.makeUnsafe<void>();
    const releaseFinalizer = Deferred.makeUnsafe<void>();
    const finished = Deferred.makeUnsafe<void>();
    let operationEnded = () => false;
    let gated = false;
    let continued = false;
    let finalized = false;
    let cancellationSettled = false;
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: `operation-state-sink-cancel/${operation}/${event}`,
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => 0),
        actions: {
          act: Driver.Action((ctx) => {
            ctx.setResult(1);
          }),
        },
      });
    }
    const sink: RuntimeSink = {
      name: `park-settled-${event}`,
      handle: (record) => {
        if (gated || record.event._tag !== event || !operationEnded()) return Effect.void;
        gated = true;
        return Deferred.succeed(parked, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.sync(() => {
              continued = true;
            })
          ),
          Effect.ensuring(
            Deferred.succeed(finalizing, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFinalizer)),
              Effect.andThen(
                Effect.sync(() => {
                  finalized = true;
                })
              ),
              Effect.andThen(Deferred.succeed(finished, undefined))
            )
          )
        );
      },
    };
    const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [sink] });
    try {
      const handle = runtime.client.node(Resource, {});
      await handle.ensureReadyNode();
      operationEnded = () => {
        const read = handle.read();
        return read._tag === "Ready" && !read.busy;
      };
      const abort = new AbortController();
      // Missing refresh hooks and args updates settle their bodies synchronously.
      const pending = (
        operation === "action"
          ? unwrapEffect(handle.action("act", undefined, { signal: abort.signal }))
          : operation === "refresh"
            ? handle.refresh()
            : handle.updateArgs({})
      ).then(
        () => "success",
        (cause: unknown) =>
          Cause.isCause(cause) && Cause.hasInterruptsOnly(cause) ? "interrupted" : "failure"
      );
      await Effect.runPromise(Deferred.await(parked));
      expect(handle.read()).toMatchObject({
        result: operation === "action" ? 1 : 0,
        busy: false,
        operation: { _tag: "Idle" },
      });
      let cancel: Promise<unknown>;
      if (operation === "action") {
        abort.abort();
        cancel = pending;
      } else cancel = handle.evict();
      const canceled = cancel.then((outcome) => {
        cancellationSettled = true;
        return outcome;
      });
      // A broken cancel returns before even starting the suspended sink's finalizer.
      const first = await Promise.race([
        Effect.runPromise(Deferred.await(finalizing)).then(() => "finalizing"),
        canceled.then(() => "settled"),
      ]);
      expect(first).toBe("finalizing");
      expect(cancellationSettled).toBe(false);
      expect(finalized).toBe(false);
      await Effect.runPromise(Deferred.succeed(releaseFinalizer, undefined));
      const outcome = await canceled;
      if (operation === "action") expect(outcome).toBe("interrupted");
      else expect(handle.read()._tag).toBe("Unwired");
      await pending;
      expect(finalized).toBe(true);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Deferred.await(finished));
      expect(continued).toBe(false);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseFinalizer, undefined));
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await runtime.submit({ _tag: "RuntimeStop" });
    }
  });
}
