/**
 * A synthetic Frond app for exercising the hub against something that moves.
 *
 * Not a test — there are no assertions here. It exists to put a realistic,
 * continuously changing graph on the other end of the socket so the dashboard,
 * the retained ring, and the MCP reader can be looked at under load rather than
 * reasoned about. Frond is a frontend runtime, but nothing in it is
 * browser-bound, so a server process is a perfectly good stand-in for an app.
 *
 * Run one instance per policy to see redaction side by side:
 *
 *   bun --conditions=source smoke/app.ts --name shape-app --values shape
 *   bun --conditions=source smoke/app.ts --name full-app  --values full --rate 8
 */
import {
  type ActionContract,
  Args,
  createRuntime,
  type Dep,
  Driver,
  dep,
  dependencies,
  facadeSpec,
  Key,
  NodeBase,
  type NodeSpec,
  nodeSpec,
  resourceSpec,
  serviceSpec,
  tag,
} from "@frondruntime/core";
import { attachDevtools, type ValuePolicy } from "@frondruntime/devtools";
import { Effect } from "effect";
import { observable, runInAction } from "mobx";

const REGIONS = ["eu-west", "us-east", "ap-south"] as const;
const TOPICS = ["orders", "prices", "positions", "alerts", "ledger"] as const;
const PAYLOAD_KINDS = ["deep", "wide", "cyclic", "exotic", "huge"] as const;

type Region = (typeof REGIONS)[number];
type Topic = (typeof TOPICS)[number];
type PayloadKind = (typeof PAYLOAD_KINDS)[number];

function pick<T>(items: ReadonlyArray<T>): T {
  // biome-ignore lint/style/noNonNullAssertion: index is derived from the length
  return items[Math.floor(Math.random() * items.length)]!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ config */

type ConfigResult = {
  readonly failureRate: number;
  readonly baseLatencyMs: number;
};

type ConfigSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: ConfigResult;
}>;

class ConfigNode extends NodeBase<ConfigSpec> {
  static readonly spec = serviceSpec.effect<ConfigSpec>({
    tag: tag("smoke/config"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => Effect.succeed({ failureRate: 0.18, baseLatencyMs: 40 })),
  });
}

/* ----------------------------------------------------------------- session */

type SessionResult = {
  readonly region: Region;
  /** Deliberately secret-shaped: under `"shape"` this must never reach the hub. */
  readonly accessToken: string;
  readonly account: { readonly id: string; readonly email: string; readonly balance: number };
  readonly openedAt: number;
};

type SessionSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: { readonly region: Region };
  readonly key: Key.Structure<{ readonly region: Region }>;
  readonly result: SessionResult;
}>;

/** A held connection with real teardown, so release shows up in the feed. */
class SessionNode extends NodeBase<SessionSpec> {
  static readonly spec = resourceSpec.effect<SessionSpec>({
    tag: tag("smoke/session"),
    key: (args) => Key.structure({ region: args.region }),
    acquire: Driver.Acquire((ctx) =>
      Effect.succeed({
        region: ctx.args.region,
        accessToken: `tok_live_${crypto.randomUUID().replaceAll("-", "")}`,
        account: {
          id: `acct_${Math.floor(Math.random() * 10_000)}`,
          email: "person@example.test",
          balance: Math.round(Math.random() * 1_000_000) / 100,
        },
        openedAt: Date.now(),
      })
    ),
    release: Driver.Release(() => Effect.void),
  });
}

/* -------------------------------------------------------------------- feed */

type FeedResult = {
  readonly topic: Topic;
  readonly region: Region;
  readonly items: ReadonlyArray<{ readonly id: number; readonly price: number }>;
  readonly fetchedAt: number;
};

type FeedSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly topic: Topic; readonly region: Region };
  readonly key: Key.Structure<{ readonly topic: Topic; readonly region: Region }>;
  readonly deps: {
    readonly config: Dep<typeof ConfigNode>;
    readonly session: Dep<typeof SessionNode>;
  };
  readonly result: FeedResult;
}>;

/**
 * The workhorse: async, dependent, latent, and unreliable.
 *
 * Its failures are the interesting part — a devtools feed that only ever shows
 * success is not being tested.
 */
class FeedNode extends NodeBase<FeedSpec> {
  static readonly spec = nodeSpec.async<FeedSpec>({
    tag: tag("smoke/feed"),
    key: (args) => Key.structure({ topic: args.topic, region: args.region }),
    dependencies: dependencies((args: { readonly topic: Topic; readonly region: Region }) => ({
      config: dep(ConfigNode, Args.none),
      session: dep(SessionNode, { region: args.region }),
    })),
    acquire: Driver.Acquire(async (ctx) => {
      const { failureRate, baseLatencyMs } = ctx.deps.config.result;

      await sleep(baseLatencyMs + Math.random() * 220);

      if (Math.random() < failureRate) {
        throw new Error(`upstream ${ctx.args.topic} unavailable in ${ctx.args.region} (503)`);
      }

      return {
        topic: ctx.args.topic,
        region: ctx.args.region,
        items: Array.from({ length: 3 + Math.floor(Math.random() * 20) }, (_, index) => ({
          id: index,
          price: Math.round(Math.random() * 100_000) / 100,
        })),
        fetchedAt: Date.now(),
      };
    }),
  });
}

/* ------------------------------------------------------------------ ledger */

type LedgerEntry = { readonly at: number; readonly what: string; readonly ok: boolean };

type LedgerResult = { readonly entries: ReturnType<typeof observable.array<LedgerEntry>> };

type LedgerSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: LedgerResult;
  readonly actions: {
    readonly record: ActionContract<{ readonly what: string; readonly ok: boolean }, void>;
    readonly trim: ActionContract<Record<string, never>, void>;
  };
}>;

/** Action traffic, so the feed carries more than acquire/release cascades. */
class LedgerNode extends NodeBase<LedgerSpec> {
  static readonly spec = serviceSpec.effect<LedgerSpec>({
    tag: tag("smoke/ledger"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() =>
      Effect.succeed({ entries: observable.array<LedgerEntry>([], { deep: false }) })
    ),
    actions: {
      record: Driver.Action((ctx, input) =>
        Effect.sync(() => {
          runInAction(() => {
            ctx.node.result.entries.push({ at: Date.now(), what: input.what, ok: input.ok });
          });
        })
      ),
      trim: Driver.Action((ctx) =>
        Effect.sync(() => {
          runInAction(() => {
            ctx.node.result.entries.replace(ctx.node.result.entries.slice(-50));
          });
        })
      ),
    },
  });

  record(what: string, ok: boolean): Effect.Effect<void, unknown> {
    return this.actions.record({ what, ok });
  }
}

/* ------------------------------------------------------------------- stats */

type StatsResult = {
  readonly total: number;
  readonly failed: number;
};

type StatsSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly deps: { readonly ledger: Dep<typeof LedgerNode> };
  readonly result: StatsResult;
}>;

/** Derived-on-read, so refreshing it costs nothing but still emits events. */
class StatsNode extends NodeBase<StatsSpec> {
  static readonly spec = facadeSpec.async<StatsSpec>({
    tag: tag("smoke/stats"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ ledger: dep(LedgerNode, Args.none) })),
    acquire: Driver.Acquire((ctx) => {
      const entries = ctx.deps.ledger.result.entries;

      return {
        get total() {
          return entries.length;
        },
        get failed() {
          return entries.filter((entry) => !entry.ok).length;
        },
      };
    }),
  });
}

/* ----------------------------------------------------------------- payload */

class Position {
  constructor(
    readonly symbol: string,
    readonly qty: number
  ) {}
}

function buildPayload(kind: PayloadKind): unknown {
  switch (kind) {
    case "deep": {
      // Past FULL_MAX_DEPTH (8), so `full` has to elide too.
      let node: Record<string, unknown> = { leaf: "bottom", secret: "deep-secret-value" };
      for (let level = 12; level > 0; level -= 1) {
        node = { level, child: node };
      }
      return node;
    }
    case "wide": {
      // Past FULL_MAX_ENTRIES (256).
      return { rows: Array.from({ length: 400 }, (_, i) => ({ i, v: `row-${i}` })) };
    }
    case "cyclic": {
      const root: Record<string, unknown> = { name: "root" };
      const child: Record<string, unknown> = { parent: root, name: "child" };
      root["child"] = child;
      root["self"] = root;
      return root;
    }
    case "exotic": {
      return {
        when: new Date(),
        big: 9_007_199_254_740_993n,
        sym: Symbol("smoke"),
        fn: function handler() {
          return 1;
        },
        map: new Map<string, unknown>([
          ["a", 1],
          ["b", { nested: true }],
        ]),
        set: new Set([1, 2, 3]),
        instance: new Position("BTC-USD", 0.25),
        err: new Error("a failure that was carried as a value"),
      };
    }
    case "huge": {
      // Past FULL_MAX_STRING_LENGTH (4096) and MAX_STRING_LENGTH (256).
      return { blob: "x".repeat(6000), note: "short enough to survive" };
    }
  }
}

type PayloadSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: { readonly kind: PayloadKind };
  readonly key: Key.Structure<{ readonly kind: PayloadKind }>;
  readonly result: { readonly kind: PayloadKind; readonly value: unknown };
}>;

/** Encoder-hostile results, one per bound the encoder claims to enforce. */
class PayloadNode extends NodeBase<PayloadSpec> {
  static readonly spec = nodeSpec.effect<PayloadSpec>({
    tag: tag("smoke/payload"),
    key: (args) => Key.structure({ kind: args.kind }),
    acquire: Driver.Acquire((ctx) =>
      Effect.succeed({ kind: ctx.args.kind, value: buildPayload(ctx.args.kind) })
    ),
  });
}

/* ------------------------------------------------------------------ driver */

type Options = {
  readonly name: string;
  readonly values: ValuePolicy | undefined;
  readonly rate: number;
  readonly url: string | undefined;
};

function parseArgs(argv: ReadonlyArray<string>): Options {
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag?.startsWith("--")) {
      flags.set(flag.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }

  const values = flags.get("values");

  return {
    name: flags.get("name") ?? "smoke-app",
    values:
      values === "none" || values === "shape" || values === "full"
        ? (values as ValuePolicy)
        : undefined,
    rate: Number(flags.get("rate") ?? "4"),
    url: flags.get("url"),
  };
}

const options = parseArgs(process.argv.slice(2));

const runtime = createRuntime();
await runtime.submit({ _tag: "RuntimeStart" });

const detach = attachDevtools({
  runtime,
  name: options.name,
  ...(options.url === undefined ? {} : { url: options.url }),
  ...(options.values === undefined ? {} : { values: options.values }),
  onError: (cause) => {
    console.error(`[${options.name}] attach:`, cause);
  },
});

const ledgerHandle = runtime.client.node(LedgerNode, Args.none);
await ledgerHandle.ensureReadyNode();

// Effect-mode actions hand back an Effect, and the driver loop below is plain
// async/await. Run them at the boundary rather than making the loop effectful:
// this is a fixture, and its readability is the point.
const record = (what: string, ok: boolean): Promise<unknown> =>
  Effect.runPromise(ledgerHandle.action("record", { what, ok }));

/** Weighted so the common operations stay common and the loud ones stay rare. */
const OPERATIONS: ReadonlyArray<readonly [weight: number, run: () => Promise<void>]> = [
  // Ensure a feed. The bread and butter: dependency cascade, latency, failures.
  [
    10,
    async () => {
      const args = { topic: pick(TOPICS), region: pick(REGIONS) };
      const handle = runtime.client.node(FeedNode, args);
      const read = await handle.ensure();
      await record(`feed:${args.topic}@${args.region}`, read._tag === "Ready");
    },
  ],
  // Refresh an existing feed: same node, new work id.
  [
    5,
    async () => {
      const args = { topic: pick(TOPICS), region: pick(REGIONS) };
      await runtime.client.node(FeedNode, args).refresh();
      await record(`refresh:${args.topic}`, true);
    },
  ],
  // Evict, so the next ensure is a cold start rather than a cache hit.
  [
    3,
    async () => {
      const args = { topic: pick(TOPICS), region: pick(REGIONS) };
      await runtime.client.node(FeedNode, args).evict("selfAndDependents", "smoke eviction");
      await record(`evict:${args.topic}`, true);
    },
  ],
  // Release a session: resource teardown with dependents attached.
  [
    2,
    async () => {
      const region = pick(REGIONS);
      await runtime.client.node(SessionNode, { region }).releaseResources("smoke release");
      await record(`release:${region}`, true);
    },
  ],
  // A payload the encoder has to work at.
  [
    3,
    async () => {
      const kind = pick(PAYLOAD_KINDS);
      await runtime.client.node(PayloadNode, { kind }).ensureReadyNode();
      await runtime.client.node(PayloadNode, { kind }).refresh();
      await record(`payload:${kind}`, true);
    },
  ],
  // Facade read.
  [
    2,
    async () => {
      const stats = await runtime.client.node(StatsNode, Args.none).ensureReadyNode();
      await record(`stats:${stats.result.total}/${stats.result.failed}`, true);
    },
  ],
  // A burst: enough action traffic in one tick to test batching and the ring.
  [
    1,
    async () => {
      await Promise.all(Array.from({ length: 120 }, (_, i) => record(`burst-${i}`, i % 7 !== 0)));
      await Effect.runPromise(ledgerHandle.action("trim", {}));
    },
  ],
];

const TOTAL_WEIGHT = OPERATIONS.reduce((sum, [weight]) => sum + weight, 0);

function nextOperation(): () => Promise<void> {
  let roll = Math.random() * TOTAL_WEIGHT;

  for (const [weight, run] of OPERATIONS) {
    roll -= weight;
    if (roll <= 0) {
      return run;
    }
  }

  // biome-ignore lint/style/noNonNullAssertion: OPERATIONS is non-empty
  return OPERATIONS[0]![1];
}

let running = true;
let ticks = 0;

const stop = async () => {
  if (!running) {
    return;
  }
  running = false;
  console.log(`\n[${options.name}] stopping after ${ticks} ticks`);
  detach();
  await runtime.submit({ _tag: "RuntimeStop", reason: "smoke stop" });
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(
  `[${options.name}] values=${options.values ?? "shape (default)"} rate=${options.rate}/s — ctrl-c to stop`
);

const interval = Math.max(20, Math.floor(1000 / Math.max(1, options.rate)));

while (running) {
  ticks += 1;

  // Failures are the point, so a rejected operation is logged and the loop
  // continues — a smoke app that dies on the first 503 tests nothing.
  await nextOperation()().catch(() => {});

  if (ticks % 50 === 0) {
    console.log(`[${options.name}] ${ticks} ticks`);
  }

  await sleep(interval);
}
