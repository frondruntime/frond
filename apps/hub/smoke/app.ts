/**
 * A synthetic Frond app for exercising the hub against something that moves.
 *
 * Not a test — there are no assertions here. It exists to put a realistic,
 * continuously changing graph on the other end of the socket so the dashboard,
 * the retained ring, and the MCP reader can be looked at under load rather than
 * reasoned about. The graph itself lives in `nodes.ts`, shared with
 * `readState.ts`, which is the half that does assert.
 *
 * Run one instance per policy to see redaction side by side:
 *
 *   bun --conditions=source smoke/app.ts --name shape-app --values shape
 *   bun --conditions=source smoke/app.ts --name full-app  --values full --rate 8
 */
import { Args, createRuntime } from "@frondruntime/core";
import { attachDevtools, type ValuePolicy } from "@frondruntime/devtools";
import { Effect } from "effect";
import {
  FeedNode,
  LedgerNode,
  PAYLOAD_KINDS,
  PayloadNode,
  pick,
  REGIONS,
  SessionNode,
  StatsNode,
  sleep,
  TOPICS,
} from "./nodes.ts";

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
