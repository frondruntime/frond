import { describe, expect, test } from "bun:test";
import { Exit, Fiber } from "effect";
import type { DisposerBag } from "../src/driver";
import {
  type ActionContract,
  createRuntime,
  type Dep,
  Driver,
  dep,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

// 0.6 intended change: teardown runs dependents first, in true dependency
// order: a node's release and disposers finish before any node it depends on
// starts its own cleanup, on eviction and on runtime stop alike.

type Timing = "instant" | "microtask";

/** A resource a node owns; its dependents use it until their cleanup ends. */
interface Resource {
  readonly name: string;
  open: boolean;
}

type ResourceSpec<TDeps> = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: TDeps;
  readonly result: Resource;
}>;

/**
 * Opens the node's resource and registers its disposer. The disposer reads
 * every dependency's resource (an unsubscribe over the dependency's
 * transport), records a closed one, and fails on it, then closes its own.
 */
function openResource(
  name: string,
  used: ReadonlyArray<Resource>,
  disposers: DisposerBag,
  trace: Array<string>,
  timing: Timing
): Resource {
  const resource: Resource = { name, open: true };
  const finish = (): void => {
    let closed = "";
    for (const dependency of used) {
      if (!dependency.open) closed = dependency.name;
    }
    resource.open = false;
    if (closed !== "") {
      trace.push(`${name}.dispose:${closed} closed`);
      throw new Error(`${name} cleanup used a closed ${closed}`);
    }
  };
  disposers.add(() => {
    trace.push(`${name}.dispose`);
    return timing === "instant" ? finish() : Promise.resolve().then(finish);
  });
  return resource;
}

function makeChain(trace: Array<string>, timing: Timing) {
  class Venue extends NodeBase<ResourceSpec<Record<string, never>>> {
    static readonly spec = serviceSpec.async<ResourceSpec<Record<string, never>>>({
      tag: `teardown/chain-venue-${timing}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) => openResource("Venue", [], ctx.disposers, trace, timing)),
      release: Driver.Release(() => {
        trace.push("Venue.release");
      }),
    });
  }
  type QuotesDeps = { readonly venue: Dep<typeof Venue> };
  class Quotes extends NodeBase<ResourceSpec<QuotesDeps>> {
    static readonly spec = serviceSpec.async<ResourceSpec<QuotesDeps>>({
      tag: `teardown/chain-quotes-${timing}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ venue: dep(Venue, {}) })),
      acquire: Driver.Acquire((ctx) =>
        openResource("Quotes", [ctx.deps.venue.result], ctx.disposers, trace, timing)
      ),
      release: Driver.Release(() => {
        trace.push("Quotes.release");
      }),
    });
  }
  return { Venue, Quotes };
}

// Edges point dependent -> dependency: Quotes->Venue, Chart->Quotes,
// Chart->Venue, Screen->Chart, Screen->Venue. Venue reaches every node, but a
// depth score puts Quotes and Chart on one level; only edge precedence gives
// Screen, Chart, Quotes, Venue.
function makeDiamond(trace: Array<string>, timing: Timing) {
  const { Venue, Quotes } = makeChain(trace, timing);
  type ChartDeps = { readonly quotes: Dep<typeof Quotes>; readonly venue: Dep<typeof Venue> };
  class Chart extends NodeBase<ResourceSpec<ChartDeps>> {
    static readonly spec = serviceSpec.async<ResourceSpec<ChartDeps>>({
      tag: `teardown/diamond-chart-${timing}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ quotes: dep(Quotes, {}), venue: dep(Venue, {}) })),
      acquire: Driver.Acquire((ctx) =>
        openResource(
          "Chart",
          [ctx.deps.quotes.result, ctx.deps.venue.result],
          ctx.disposers,
          trace,
          timing
        )
      ),
      release: Driver.Release(() => {
        trace.push("Chart.release");
      }),
    });
  }
  type ScreenDeps = { readonly chart: Dep<typeof Chart>; readonly venue: Dep<typeof Venue> };
  class Screen extends NodeBase<ResourceSpec<ScreenDeps>> {
    static readonly spec = serviceSpec.async<ResourceSpec<ScreenDeps>>({
      tag: `teardown/diamond-screen-${timing}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ chart: dep(Chart, {}), venue: dep(Venue, {}) })),
      acquire: Driver.Acquire((ctx) =>
        openResource(
          "Screen",
          [ctx.deps.chart.result, ctx.deps.venue.result],
          ctx.disposers,
          trace,
          timing
        )
      ),
      release: Driver.Release(() => {
        trace.push("Screen.release");
      }),
    });
  }
  return { Venue, Screen };
}

const chainTrace = ["Quotes.release", "Quotes.dispose", "Venue.release", "Venue.dispose"];
const diamondTrace = [
  "Screen.release",
  "Screen.dispose",
  "Chart.release",
  "Chart.dispose",
  ...chainTrace,
];

describe.each(["instant", "microtask"] as const)("teardown order, %s disposers", (timing) => {
  test("eviction cleans up a dependent before its dependency", async () => {
    const trace: Array<string> = [];
    const { Venue, Quotes } = makeChain(trace, timing);
    const runtime = createRuntime();
    await runtime.client.node(Quotes, {}).ensureReady();

    const result = await runtime.client.node(Venue, {}).evict("selfAndDependents", "teardown");

    expect(trace).toEqual(chainTrace);
    expect(result.failures).toEqual([]);
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("runtime stop cleans up a dependent before its dependency", async () => {
    const trace: Array<string> = [];
    const { Quotes } = makeChain(trace, timing);
    const runtime = createRuntime();
    await runtime.client.node(Quotes, {}).ensureReady();

    await runtime.submit({ _tag: "RuntimeStop" });

    expect(trace).toEqual(chainTrace);
  });

  test("eviction follows edge precedence, not dependency depth", async () => {
    const trace: Array<string> = [];
    const { Venue, Screen } = makeDiamond(trace, timing);
    const runtime = createRuntime();
    await runtime.client.node(Screen, {}).ensureReady();

    const result = await runtime.client.node(Venue, {}).evict("selfAndDependents", "teardown");

    expect(trace).toEqual(diamondTrace);
    expect(result.failures).toEqual([]);
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("runtime stop follows edge precedence, not dependency depth", async () => {
    const trace: Array<string> = [];
    const { Screen } = makeDiamond(trace, timing);
    const runtime = createRuntime();
    await runtime.client.node(Screen, {}).ensureReady();

    await runtime.submit({ _tag: "RuntimeStop" });

    expect(trace).toEqual(diamondTrace);
  });
});

// Regression: stop must not wait for one cell's canceled work to drain before
// it starts the cleanup of a node that is not that cell's dependency, whether
// that node has dependents of its own or not.
async function stopWhileCanceledWorkDrains(placement: "alone" | "with a dependent") {
  const trace: Array<string> = [];
  let releaseFinalizer: () => void = () => undefined;
  const finalizerGate = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tag = placement === "alone" ? "alone" : "held";

  type WorkerSpec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: string;
    readonly actions: { readonly hang: ActionContract<void, string> };
  }>;
  class Worker extends NodeBase<WorkerSpec> {
    static readonly spec = serviceSpec.effect<WorkerSpec>({
      tag: `teardown/drain-worker-${tag}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => Effect.succeed("worker")),
      actions: {
        // The canceled work's finalizer waits for the unrelated node's disposer.
        hang: Driver.Action(
          () =>
            Effect.sync(markStarted).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.promise(() => finalizerGate).pipe(
                  Effect.andThen(Effect.sync(() => trace.push("Worker.drained")))
                )
              )
            ),
          { timeout: "unbounded" }
        ),
      },
    });
  }

  type GateSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: string;
  }>;
  class Gate extends NodeBase<GateSpec> {
    static readonly spec = serviceSpec.async<GateSpec>({
      tag: `teardown/drain-gate-${tag}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) => {
        ctx.disposers.add(() => {
          trace.push("Gate.dispose");
          releaseFinalizer();
        });
        return "gate";
      }),
    });
  }

  type HolderSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: { readonly gate: Dep<typeof Gate> };
    readonly result: string;
  }>;
  class Holder extends NodeBase<HolderSpec> {
    static readonly spec = serviceSpec.async<HolderSpec>({
      tag: `teardown/drain-holder-${tag}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ gate: dep(Gate, {}) })),
      acquire: Driver.Acquire(() => "holder"),
    });
  }

  const runtime = createRuntime({ driverTimeouts: { release: 20, live: 20 } });
  await runtime.client.node(Worker, {}).ensureReady();
  if (placement === "alone") await runtime.client.node(Gate, {}).ensureReady();
  else await runtime.client.node(Holder, {}).ensureReady();
  const hanging = Effect.runPromiseExit(runtime.client.node(Worker, {}).action("hang"));
  await started;

  const stopped = await Promise.race([
    runtime.submit({ _tag: "RuntimeStop" }).then(() => "stopped"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500)),
  ]);
  releaseFinalizer();
  await hanging;

  expect(stopped).toBe("stopped");
  expect(trace).toEqual(["Gate.dispose", "Worker.drained"]);
}

test("runtime stop cleans up a node while an unrelated node's canceled work drains", () =>
  stopWhileCanceledWorkDrains("alone"));

test("runtime stop cleans up a node with a dependent while an unrelated node's canceled work drains", () =>
  stopWhileCanceledWorkDrains("with a dependent"));

test("runtime stop starts a dependency's cleanup only after both of its dependents finish", async () => {
  const trace: Array<string> = [];
  const delayed = (name: string, milliseconds: number) => () => {
    trace.push(`${name}.dispose:start`);
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        trace.push(`${name}.dispose:end`);
        resolve();
      }, milliseconds)
    );
  };

  type VenueSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: string;
  }>;
  class SharedVenue extends NodeBase<VenueSpec> {
    static readonly spec = serviceSpec.async<VenueSpec>({
      tag: "teardown/shared-venue",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => "venue"),
      release: Driver.Release(() => {
        trace.push("Venue.release");
      }),
    });
  }
  type FeedSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: { readonly name: string; readonly delay: number };
    readonly key: string;
    readonly deps: { readonly venue: Dep<typeof SharedVenue> };
    readonly result: string;
  }>;
  class Feed extends NodeBase<FeedSpec> {
    static readonly spec = serviceSpec.async<FeedSpec>({
      tag: "teardown/shared-feed",
      key: (args) => args.name,
      dependencies: dependencies(() => ({ venue: dep(SharedVenue, {}) })),
      acquire: Driver.Acquire((ctx) => {
        ctx.disposers.add(delayed(ctx.args.name, ctx.args.delay));
        return ctx.args.name;
      }),
    });
  }

  const runtime = createRuntime();
  await runtime.client.node(Feed, { name: "Slow", delay: 30 }).ensureReady();
  await runtime.client.node(Feed, { name: "Fast", delay: 5 }).ensureReady();

  await runtime.submit({ _tag: "RuntimeStop" });

  expect(trace.indexOf("Venue.release")).toBe(trace.length - 1);
  expect(trace.slice(0, 2).sort()).toEqual(["Fast.dispose:start", "Slow.dispose:start"]);
  expect(trace.slice(2, 4)).toEqual(["Fast.dispose:end", "Slow.dispose:end"]);
});

// A dependent's canceled work that drains within `driverTimeouts.release`
// still drains before the dependent's cleanup, and the dependency's cleanup
// waits for both. Work that drains later stops holding the dependency back
// once the bound expires, so a finalizer that waits for the dependency's
// teardown no longer hangs stop or eviction; both still end only after the
// drain.
async function teardownWhileDependentDrains(
  teardown: "stop" | "eviction",
  finalizer: "finishes in time" | "awaits the dependency"
) {
  const trace: Array<string> = [];
  let releaseFinalizer: () => void = () => undefined;
  const dependencyGate = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });
  // The in-time finalizer starts its delay only once stop interrupts the work.
  const finalizerGate = () =>
    finalizer === "finishes in time"
      ? new Promise<void>((resolve) => setTimeout(resolve, 10))
      : dependencyGate;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tag = `${teardown}-${finalizer === "finishes in time" ? "in-time" : "late"}`;

  type BaseSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: string;
  }>;
  class Base extends NodeBase<BaseSpec> {
    static readonly spec = serviceSpec.async<BaseSpec>({
      tag: `teardown/dependent-drain-base-${tag}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) => {
        ctx.disposers.add(() => {
          trace.push("Base.dispose");
          releaseFinalizer();
        });
        return "base";
      }),
    });
  }

  type WorkerSpec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: { readonly base: Dep<typeof Base> };
    readonly result: string;
    readonly actions: { readonly hang: ActionContract<void, string> };
  }>;
  class Worker extends NodeBase<WorkerSpec> {
    static readonly spec = serviceSpec.effect<WorkerSpec>({
      tag: `teardown/dependent-drain-worker-${tag}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ base: dep(Base, {}) })),
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          ctx.disposers.add(() => {
            trace.push("Worker.dispose");
          });
          return "worker";
        })
      ),
      actions: {
        hang: Driver.Action(
          () =>
            Effect.sync(markStarted).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.promise(finalizerGate).pipe(
                  Effect.andThen(Effect.sync(() => trace.push("Worker.drained")))
                )
              )
            ),
          { timeout: "unbounded" }
        ),
      },
    });
  }

  const release = finalizer === "finishes in time" ? 200 : 20;
  const runtime = createRuntime({ driverTimeouts: { release, live: 20 } });
  await runtime.client.node(Worker, {}).ensureReady();
  const hanging = Effect.runPromiseExit(runtime.client.node(Worker, {}).action("hang"));
  await started;

  let traceAtEnd: ReadonlyArray<string> = [];
  const ended = await Promise.race([
    (teardown === "stop"
      ? runtime.submit({ _tag: "RuntimeStop" })
      : runtime.client.node(Base, {}).evict("selfAndDependents", "teardown")
    ).then(() => {
      traceAtEnd = trace.slice();
      return "ended";
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500)),
  ]);
  releaseFinalizer();
  await hanging;

  return { ended, trace: traceAtEnd };
}

describe.each(["stop", "eviction"] as const)("%s with a draining dependent", (teardown) => {
  test("drains a dependent's canceled work before its cleanup and its dependency's", async () => {
    const { ended, trace } = await teardownWhileDependentDrains(teardown, "finishes in time");

    expect(ended).toBe("ended");
    expect(trace).toEqual(["Worker.drained", "Worker.dispose", "Base.dispose"]);
  });

  test("bounds a dependent's drain whose finalizer waits for its dependency's cleanup", async () => {
    // 0.6 intended change: Worker cleans up before Base, as dependents now go first, and its drain wait is bounded by driverTimeouts.release; 0.5 disposed Base first, so the drain ended before Worker's cleanup.
    const { ended, trace } = await teardownWhileDependentDrains(teardown, "awaits the dependency");

    expect(ended).toBe("ended");
    expect(trace).toEqual(["Worker.dispose", "Base.dispose", "Worker.drained"]);
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const neverSettles = (): Promise<void> => new Promise<void>(() => {});

/** A gate the test opens, and a signal the work behind it has started. */
function testGate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Runs until canceled, then drains only once `drain` opens. */
const hangUntilCanceled = (
  name: string,
  trace: Array<string>,
  started: () => void,
  drain: Promise<void>
) =>
  Effect.sync(started).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(
      Effect.promise(() => drain).pipe(
        Effect.andThen(Effect.sync(() => trace.push(`${name}.drained`)))
      )
    )
  );

type DrainingSpec<TDeps> = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: TDeps;
  readonly result: string;
  readonly actions: { readonly hang: ActionContract<void, string> };
}>;

const hang = (request: { readonly spec: unknown; readonly args: Record<string, never> }) =>
  ({ target: { _tag: "NodeRequest", request }, action: "hang", input: undefined }) as const;

type CancelPoint = "within the bound" | "after the bound" | "during the late cleanup";

/**
 * Starts an action whose finalizer waits for the test, evicts its node, and
 * cancels the eviction while it waits for the drain within the release
 * bound, after the bound once the node's cleanup has run, or after the bound
 * while the cleanup's disposer still hangs within its own bound.
 */
async function cancelEvictionWhileWorkDrains(cancel: CancelPoint) {
  const trace: Array<string> = [];
  const drain = testGate();
  const started = testGate();

  class Worker extends NodeBase<DrainingSpec<Record<string, never>>> {
    static readonly spec = serviceSpec.effect<DrainingSpec<Record<string, never>>>({
      tag: `teardown/canceled-eviction-${cancel.replaceAll(" ", "-")}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          trace.push("Worker.acquire");
          ctx.disposers.add(() => {
            trace.push("Worker.dispose");
            if (cancel === "during the late cleanup") return neverSettles();
          });
          return "worker";
        })
      ),
      actions: {
        hang: Driver.Action(() => hangUntilCanceled("Worker", trace, started.open, drain.opened), {
          timeout: "unbounded",
        }),
      },
    });
  }

  const release = cancel === "within the bound" ? 100 : 20;
  const graph = makeInMemoryGraphSystem({ driverTimeouts: { release, live: 20 } });
  const request = { spec: Worker, args: {} };
  const { nodeId } = await Effect.runPromise(graph.ensureReadyNode(request));
  const hanging = Effect.runPromiseExit(graph.runAction(hang(request)));
  await started.opened;

  const eviction = Effect.runFork(
    graph.evictSubgraph({ rootNodeIds: [nodeId], mode: "selfAndDependents", reason: "teardown" })
  );
  if (cancel === "within the bound") await sleep(20);
  else while (!trace.includes("Worker.dispose")) await sleep(1);
  const canceled = Effect.runPromise(
    Fiber.interrupt(eviction).pipe(Effect.andThen(Fiber.await(eviction)))
  );

  // Holds the drain past every bound, then opens it; returns the trace from
  // the opening on, once `pending`, the eviction, and the action have ended.
  const finishDrain = async (pending: Promise<unknown>) => {
    await sleep(release + 150);
    trace.push("drain opened");
    drain.open();
    await pending;
    await hanging;
    return { trace: trace.slice(trace.indexOf("drain opened")), canceled: await canceled };
  };
  return { graph, request, trace, finishDrain };
}

describe("a canceled eviction keeps owning its late drain", () => {
  // 0.6 intended change: once a drain outlives its bound, canceling the eviction no longer ends it: it cleans up the remaining nodes, waits for the drain, then settles as interrupted; 0.5 had no bound, so a cancel always landed while the drain still held the node's queue.
  // Canceled within the bound, the eviction leaves the node in place with its
  // queue closed, as 0.5 did, and stop waits for the drain.
  test.each([
    "within the bound",
    "after the bound",
    "during the late cleanup",
  ] as const)("stop waits for the drain of an eviction canceled %s", async (cancel) => {
    const { graph, trace, finishDrain } = await cancelEvictionWhileWorkDrains(cancel);
    const stopped = Effect.runPromise(graph.stop()).then(() => {
      trace.push("stopped");
    });

    const end = await finishDrain(stopped);
    expect(end.trace).toEqual(["drain opened", "Worker.drained", "stopped"]);
    expect(Exit.hasInterrupts(end.canceled)).toBe(true);
  });

  test.each([
    "after the bound",
    "during the late cleanup",
  ] as const)("a reacquire waits for the drain of an eviction canceled %s", async (cancel) => {
    const { graph, request, trace, finishDrain } = await cancelEvictionWhileWorkDrains(cancel);
    const reacquired = Effect.runPromise(graph.ensureReadyNode(request)).then(() => {
      trace.push("reacquired");
    });

    const end = await finishDrain(reacquired);
    expect(end.trace).toEqual(["drain opened", "Worker.drained", "Worker.acquire", "reacquired"]);
    await Effect.runPromise(graph.stop());
  });

  test("an eviction canceled between nodes still cleans up the rest and waits for every drain", async () => {
    const trace: Array<string> = [];
    const baseDrain = testGate();
    const workerDrain = testGate();
    const baseStarted = testGate();
    const workerStarted = testGate();

    class Base extends NodeBase<DrainingSpec<Record<string, never>>> {
      static readonly spec = serviceSpec.effect<DrainingSpec<Record<string, never>>>({
        tag: "teardown/canceled-eviction-chain-base",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(() => {
              trace.push("Base.dispose");
            });
            return "base";
          })
        ),
        actions: {
          hang: Driver.Action(
            () => hangUntilCanceled("Base", trace, baseStarted.open, baseDrain.opened),
            { timeout: "unbounded" }
          ),
        },
      });
    }
    type WorkerDeps = { readonly base: Dep<typeof Base> };
    class Worker extends NodeBase<DrainingSpec<WorkerDeps>> {
      static readonly spec = serviceSpec.effect<DrainingSpec<WorkerDeps>>({
        tag: "teardown/canceled-eviction-chain-worker",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ base: dep(Base, {}) })),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(() => {
              trace.push("Worker.dispose");
            });
            return "worker";
          })
        ),
        actions: {
          hang: Driver.Action(
            () => hangUntilCanceled("Worker", trace, workerStarted.open, workerDrain.opened),
            { timeout: "unbounded" }
          ),
        },
      });
    }

    const graph = makeInMemoryGraphSystem({ driverTimeouts: { release: 100, live: 20 } });
    const base = { spec: Base, args: {} };
    const worker = { spec: Worker, args: {} };
    await Effect.runPromise(graph.ensureReadyNode(worker));
    const { nodeId } = await Effect.runPromise(graph.ensureReadyNode(base));
    const baseHanging = Effect.runPromiseExit(graph.runAction(hang(base)));
    const workerHanging = Effect.runPromiseExit(graph.runAction(hang(worker)));
    await baseStarted.opened;
    await workerStarted.opened;

    const eviction = Effect.runFork(
      graph.evictSubgraph({ rootNodeIds: [nodeId], mode: "selfAndDependents", reason: "teardown" })
    );
    // Worker's drain outlived its bound and its cleanup ran: the eviction now
    // waits within Base's bound.
    while (!trace.includes("Worker.dispose")) await sleep(1);
    const canceled = Effect.runPromise(
      Fiber.interrupt(eviction).pipe(Effect.andThen(Fiber.await(eviction)))
    );
    let canceledBeforeDrains = false;
    void canceled.then(() => {
      canceledBeforeDrains = !trace.includes("Worker.drained");
    });

    await sleep(150);
    trace.push("stop");
    const stopped = Effect.runPromise(graph.stop()).then(() => {
      trace.push("stopped");
    });
    await sleep(50);
    trace.push("Base drain opened");
    baseDrain.open();
    await sleep(50);
    trace.push("Worker drain opened");
    workerDrain.open();
    await stopped;
    await baseHanging;
    await workerHanging;

    expect(trace).toEqual([
      "Worker.dispose",
      "Base.dispose",
      "stop",
      "Base drain opened",
      "Base.drained",
      "Worker drain opened",
      "Worker.drained",
      "stopped",
    ]);
    expect(Exit.hasInterrupts(await canceled)).toBe(true);
    expect(canceledBeforeDrains).toBe(false);
  });
});
