/**
 * The synthetic graph both smoke entry points run against.
 *
 * Split out of `app.ts` rather than duplicated, because the two exercises ask
 * different questions of the *same* shapes: `app.ts` drives them continuously so
 * the dashboard and the retained ring have something moving to show, and
 * `readState.ts` reads one instant of them back through MCP. A second copy of
 * these specs would let the tool under test agree with a fixture the daemon
 * never sees.
 *
 * Nothing here is browser-bound — Frond is a frontend runtime, but a server
 * process is a perfectly good stand-in for an app.
 */
import {
  type ActionContract,
  Args,
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
import { Effect } from "effect";
import { observable, runInAction } from "mobx";

export const REGIONS = ["eu-west", "us-east", "ap-south"] as const;
export const TOPICS = ["orders", "prices", "positions", "alerts", "ledger"] as const;
export const PAYLOAD_KINDS = ["deep", "wide", "cyclic", "exotic", "huge"] as const;

export type Region = (typeof REGIONS)[number];
export type Topic = (typeof TOPICS)[number];
export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

export function pick<T>(items: ReadonlyArray<T>): T {
  // biome-ignore lint/style/noNonNullAssertion: index is derived from the length
  return items[Math.floor(Math.random() * items.length)]!;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ config */

export type ConfigResult = {
  readonly failureRate: number;
  readonly baseLatencyMs: number;
};

type ConfigSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: ConfigResult;
}>;

/**
 * Two numbers and no drama.
 *
 * The one fixture result small enough to be quoted whole in an assertion, which
 * is what makes it the node a value-projection check reads: at `"full"` it is
 * expected to arrive as itself, so any redaction or re-encoding on the way
 * through the snapshot shows up as a mismatch rather than as a shrug.
 */
export class ConfigNode extends NodeBase<ConfigSpec> {
  static readonly spec = serviceSpec.effect<ConfigSpec>({
    tag: tag("smoke/config"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => Effect.succeed({ failureRate: 0.18, baseLatencyMs: 40 })),
  });
}

/** What `ConfigNode` always resolves to, so a reader can assert on it. */
export const CONFIG_RESULT: ConfigResult = { failureRate: 0.18, baseLatencyMs: 40 };

/* ----------------------------------------------------------------- session */

export type SessionResult = {
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
export class SessionNode extends NodeBase<SessionSpec> {
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

export type FeedResult = {
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
 * success is not being tested. It is also the only fixture node with two
 * dependencies, which makes it the one that puts edges in a graph snapshot.
 */
export class FeedNode extends NodeBase<FeedSpec> {
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

export type LedgerEntry = { readonly at: number; readonly what: string; readonly ok: boolean };

export type LedgerResult = { readonly entries: ReturnType<typeof observable.array<LedgerEntry>> };

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
export class LedgerNode extends NodeBase<LedgerSpec> {
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

export type StatsResult = {
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
export class StatsNode extends NodeBase<StatsSpec> {
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
      // Past FULL_MAX_DEPTH (24), so `full` has to elide too.
      let node: Record<string, unknown> = { leaf: "bottom", secret: "deep-secret-value" };
      for (let level = 30; level > 0; level -= 1) {
        node = { level, child: node };
      }
      return node;
    }
    case "wide": {
      // Past FULL_MAX_ENTRIES (4096).
      return { rows: Array.from({ length: 5000 }, (_, i) => ({ i, v: `row-${i}` })) };
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
      // Past FULL_MAX_STRING_LENGTH (65536) and MAX_STRING_LENGTH (256).
      return { blob: "x".repeat(70_000), note: "short enough to survive" };
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
export class PayloadNode extends NodeBase<PayloadSpec> {
  static readonly spec = nodeSpec.effect<PayloadSpec>({
    tag: tag("smoke/payload"),
    key: (args) => Key.structure({ kind: args.kind }),
    acquire: Driver.Acquire((ctx) =>
      Effect.succeed({ kind: ctx.args.kind, value: buildPayload(ctx.args.kind) })
    ),
  });
}
