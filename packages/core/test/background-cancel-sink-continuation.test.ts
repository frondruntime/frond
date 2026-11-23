// 0.6 restores 0.5: cancelling a refresh or args update interrupts its running pre-driver sink, then ends the operation once.
import { expect, test } from "bun:test";
import { Effect } from "effect";
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

interface Handle {
  readonly refresh: () => Promise<unknown>;
  readonly updateArgs: (args: { readonly value: number }) => Promise<unknown>;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const operations = [
  {
    kind: "a refresh",
    tag: "refresh",
    started: "GraphRefreshStarted",
    start: (handle: Handle) => handle.refresh(),
  },
  {
    kind: "an args update",
    tag: "args",
    started: "GraphNodeArgsUpdateStarted",
    start: (handle: Handle) => handle.updateArgs({ value: 2 }),
  },
] as const;

// The pre-driver sinks: the operation's start event, then the first change
// notice after it.
const sinks = ["start", "first change"] as const;

for (const { kind, tag, started, start } of operations) {
  for (const parkedSink of sinks) {
    test(`${kind} evicted during its ${parkedSink} sink interrupts that sink and starts no further sink`, async () => {
      let refreshRuns = 0;
      class Resource extends NodeBase<Spec> {
        static readonly spec = serviceSpec.async<Spec>({
          tag: `background-cancel/sink/${tag}/${parkedSink === "start" ? "start" : "change"}`,
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          acquire: Driver.Acquire((ctx) => ctx.args.value),
          refresh: Driver.Refresh((ctx) => {
            refreshRuns += 1;
            ctx.setResult(ctx.args.value);
          }),
        });
      }
      const parked = Promise.withResolvers<void>();
      const state = {
        sawStart: false,
        gated: false,
        evicting: false,
        interrupted: false,
        release: () => {},
      };
      const afterEviction: string[] = [];
      const sink: RuntimeSink = {
        name: "park-pre-driver-sink",
        handle: (record) => {
          const event = record.event._tag;
          if (state.evicting) afterEviction.push(event);
          if (event === started) state.sawStart = true;
          const target =
            parkedSink === "start"
              ? event === started
              : state.sawStart && event === "GraphNodeChanged";
          if (state.gated || !target) return Effect.void;
          state.gated = true;
          return Effect.callback<void>((resume) => {
            state.release = () => resume(Effect.void);
            parked.resolve();
            return Effect.sync(() => {
              state.interrupted = true;
            });
          });
        },
      };
      const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [sink] });
      try {
        const handle = runtime.client.node(Resource, { value: 1 });
        await handle.ensureReadyNode();
        const operation = start(handle).then(
          () => "settled",
          () => "settled"
        );
        await parked.promise;
        state.evicting = true;
        await handle.evict("selfAndDependents", "evicted during a pre-driver sink");
        expect(await operation).toBe("settled");
        // The eviction's cancel interrupts the parked sink and runs its finalizer.
        expect(state.interrupted).toBe(true);
        state.release();
        await macrotask();
        await macrotask();
        // One change notice, the cancel's own for ending the operation; the
        // interrupted sink's continuation starts no sink of its own.
        expect(afterEviction.filter((event) => event === "GraphNodeChanged")).toHaveLength(1);
        expect(refreshRuns).toBe(0);
      } finally {
        state.release();
        await runtime.submit({ _tag: "RuntimeStop" });
      }
    }, 5000);
  }
}
