import { expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  type RuntimeSink,
  serviceSpec,
} from "../src/index";

type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly value: number };
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
}>;

test("an aborted args-update caller still leaves the handle on the committed args", async () => {
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "args/abort-after-submit",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) => ctx.args.value),
      refresh: Driver.Refresh(async (ctx) => {
        refreshing.resolve();
        await release.promise;
        ctx.setResult(ctx.args.value);
      }),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const events: string[] = [];
  const subscription = runtime.observe((record) => {
    if (record.event._tag === "GraphNodeArgsUpdateSucceeded") events.push(record.event._tag);
  });
  try {
    const handle = runtime.client.node(Resource, { value: 1 });
    const node = await handle.ensureReadyNode();
    const abort = new AbortController();
    const pending = handle.updateArgs({ value: 2 }, { signal: abort.signal }).then(
      (value) => value,
      (cause: unknown) => cause
    );
    await refreshing.promise;
    abort.abort();
    release.resolve();
    const rejection = await pending;
    expect(Cause.isCause(rejection) && Cause.hasInterruptsOnly(rejection)).toBe(true);
    // Queue behind the args operation, which commits although its caller left.
    await handle.ensureReady();
    expect(node.result).toBe(2);
    expect(node.args).toEqual({ value: 2 });
    expect(handle.args).toEqual(node.args);
    expect(events).toEqual(["GraphNodeArgsUpdateSucceeded"]);
  } finally {
    subscription.unsubscribe();
    release.resolve();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

test("an args update aborted before it is planned never commits", async () => {
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "args/abort-before-plan",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) => ctx.args.value),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  try {
    const handle = runtime.client.node(Resource, { value: 1 });
    const node = await handle.ensureReadyNode();
    const abort = new AbortController();
    const pending = handle.updateArgs({ value: 2 }, { signal: abort.signal }).then(
      (value) => value,
      (cause: unknown) => cause
    );
    abort.abort();
    expect(Cause.isCause(await pending)).toBe(true);
    await handle.ensureReady();
    expect(node.args).toEqual({ value: 1 });
    expect(handle.args).toEqual({ value: 1 });
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

// Holds the reply of the first args update that commits in its completion
// sink, so a later update can commit and reply before it.
function holdFirstArgsReply() {
  const entered = Promise.withResolvers<void>();
  const finalized = Promise.withResolvers<void>();
  let resumeHeld = () => {};
  let gated = false;
  const sink: RuntimeSink = {
    name: "hold-first-args-reply",
    handle: (record) => {
      if (record.event._tag !== "GraphNodeArgsUpdateSucceeded" || gated) return Effect.void;
      gated = true;
      return Effect.callback<void>((resume) => {
        resumeHeld = () => resume(Effect.void);
        entered.resolve();
      }).pipe(Effect.ensuring(Effect.sync(() => finalized.resolve())));
    },
  };
  return {
    sink,
    entered: entered.promise,
    release: async () => {
      if (!gated) return;
      resumeHeld();
      await finalized.promise;
    },
  };
}

class OrderedResource extends NodeBase<Spec> {
  static readonly spec = serviceSpec.async<Spec>({
    tag: "args/late-older-reply",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire((ctx) => ctx.args.value),
    refresh: Driver.Refresh((ctx) => {
      if (ctx.args.value < 0) throw new Error("rejected args");
      ctx.setResult(ctx.args.value);
    }),
  });
}

// 0.6 intended change: fixes a 0.5 bug — a late reply from an older args update no longer rewinds handle.args.
for (const aborted of [true, false]) {
  test(`a late reply from an older ${aborted ? "aborted " : ""}args update does not rewind the handle`, async () => {
    const held = holdFirstArgsReply();
    const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [held.sink] });
    try {
      const handle = runtime.client.node(OrderedResource, { value: 1 });
      const node = await handle.ensureReadyNode();
      const abort = new AbortController();
      const first = handle
        .updateArgs({ value: 2 }, aborted ? { signal: abort.signal } : undefined)
        .catch((cause: unknown) => cause);
      await held.entered;
      if (aborted) abort.abort();
      expect(await handle.updateArgs({ value: 3 })).toMatchObject({ _tag: "Success" });
      expect(handle.args).toEqual({ value: 3 });
      await held.release();
      const settled = await first;
      if (aborted) expect(Cause.isCause(settled)).toBe(true);
      else expect(settled).toMatchObject({ _tag: "Success" });
      // A command through the same runtime drains posted sink continuations.
      await runtime.submit({ _tag: "RuntimeStart" });
      expect(node.args).toEqual({ value: 3 });
      expect(node.result).toBe(3);
      expect(handle.args).toEqual(node.args);
    } finally {
      await held.release();
      await runtime.submit({ _tag: "RuntimeStop" });
    }
  });
}

test("a late reply from an older committed args update applies after a newer one failed", async () => {
  const held = holdFirstArgsReply();
  const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [held.sink] });
  try {
    const handle = runtime.client.node(OrderedResource, { value: 1 });
    const node = await handle.ensureReadyNode();
    const first = handle.updateArgs({ value: 2 });
    await held.entered;
    // The newer update fails and rolls the node back to the older update's args.
    expect(await handle.updateArgs({ value: -1 })).toMatchObject({ _tag: "Failure" });
    expect(node.args).toEqual({ value: 2 });
    await held.release();
    expect(await first).toMatchObject({ _tag: "Success" });
    expect(node.result).toBe(2);
    expect(handle.args).toEqual({ value: 2 });
  } finally {
    await held.release();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
