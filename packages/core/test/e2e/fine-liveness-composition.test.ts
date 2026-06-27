import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { autorun, observable, onBecomeObserved, onBecomeUnobserved, runInAction } from "mobx";
import { Args, Driver, Key, NodeBase, type NodeSpec, resourceSpec, tag } from "../../src";
import type { NodeLiveDemandSnapshot } from "../../src/graph";
import { createNode, type MobXNode } from "../../src/mobx";
import type { RuntimeEventRecord } from "../../src/runtime";
import { createFrondTestHarness, type FrondTestHarness } from "../../src/testing";

type Pair = "BTC/USD" | "ETH/USD" | "SOL/USD";

type RatesResult = {
  readonly rates: ReturnType<typeof observable.map<Pair, number>>;
};

type FineLiveResource = {
  current: NodeLiveDemandSnapshot;
};

const fineLiveStarts: Array<NodeLiveDemandSnapshot> = [];
const fineLiveUpdates: Array<NodeLiveDemandSnapshot> = [];
const fineLiveStops: Array<NodeLiveDemandSnapshot> = [];

type FineRatesSpec = NodeSpec<{
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: RatesResult;
}>;

class FineRatesNode extends NodeBase<FineRatesSpec> {
  static readonly spec = resourceSpec<FineRatesSpec>({
    tag: tag("e2e/fine-liveness/rates"),
    key: () => Key.singleton(),
    driver: Driver.Effect<FineRatesSpec>({
      acquire: Driver.Acquire(() =>
        Effect.succeed({
          rates: observable.map<Pair, number>([
            ["BTC/USD", 63_000],
            ["ETH/USD", 3_100],
            ["SOL/USD", 148],
          ]),
        })
      ),
      live: Driver.Live<NodeBase<FineRatesSpec>, FineLiveResource>({
        start: (_ctx, demand) =>
          Effect.sync(() => {
            fineLiveStarts.push(demand);
            return { current: demand } satisfies FineLiveResource;
          }),
        update: (_ctx, resource, demand) =>
          Effect.sync(() => {
            fineLiveUpdates.push(demand);
            resource.current = demand;
          }),
        stop: (_ctx, resource) =>
          Effect.sync(() => {
            fineLiveStops.push(resource.current);
          }),
      }),
    }),
  });

  constructor() {
    super();

    for (const pair of this.result.rates.keys()) {
      this.onRuntimeClose(
        onBecomeObserved(this.result.rates, pair, () => {
          this.reportPairObserved(pair, true);
        })
      );
      this.onRuntimeClose(
        onBecomeUnobserved(this.result.rates, pair, () => {
          this.reportPairObserved(pair, false);
        })
      );
    }
  }

  getRate(pair: Pair): number {
    return this.untrackedResult().rates.get(pair) ?? 0;
  }

  reportPairObserved(pair: Pair, observed: boolean): void {
    this.reportResultObserved({ field: "rates", pair }, observed);
  }
}

describe("e2e fine-grained liveness composition", () => {
  test("keyed MobX reads create, switch, and release exact live scopes", async () => {
    fineLiveStarts.length = 0;
    fineLiveUpdates.length = 0;
    fineLiveStops.length = 0;
    const harness = createFrondTestHarness();
    const projection = createNode(harness.runtime, FineRatesNode, Args.none);

    await harness.start();
    await projection.ensureReady();
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    await harness.runtime.getSnapshot();
    await harness.runtime.query({ _tag: "RuntimeEvents" });
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    const selectedPair = observable.box<Pair>("BTC/USD");
    const stop = autorun(() => {
      void projection.node.getRate(selectedPair.get());
    });

    await waitForLiveDemand(
      harness,
      projection,
      {
        isLive: true,
        sources: ["mobx"],
        scopes: [{ field: "rates", pair: "BTC/USD" }],
      },
      0
    );
    expect(fineLiveStarts).toEqual([
      {
        isLive: true,
        sources: ["mobx"],
        scopes: [{ field: "rates", pair: "BTC/USD" }],
      },
    ]);
    expect(fineLiveUpdates).toEqual([]);
    expect(fineLiveStops).toEqual([]);

    runInAction(() => {
      selectedPair.set("ETH/USD");
    });

    await waitForLiveDemand(
      harness,
      projection,
      {
        isLive: true,
        sources: ["mobx"],
        scopes: [{ field: "rates", pair: "ETH/USD" }],
      },
      1
    );
    expect(fineLiveStarts).toEqual([
      {
        isLive: true,
        sources: ["mobx"],
        scopes: [{ field: "rates", pair: "BTC/USD" }],
      },
    ]);
    expect(fineLiveUpdates).toEqual([
      {
        isLive: true,
        sources: ["mobx"],
        scopes: [
          { field: "rates", pair: "BTC/USD" },
          { field: "rates", pair: "ETH/USD" },
        ],
      },
      {
        isLive: true,
        sources: ["mobx"],
        scopes: [{ field: "rates", pair: "ETH/USD" }],
      },
    ]);
    expect(fineLiveStops).toEqual([]);

    stop();

    await waitForLiveDemand(
      harness,
      projection,
      {
        isLive: false,
        sources: [],
        scopes: [],
      },
      2
    );
    expect(fineLiveStops).toEqual([
      {
        isLive: true,
        sources: ["mobx"],
        scopes: [{ field: "rates", pair: "ETH/USD" }],
      },
    ]);

    projection.dispose();
  });
});

async function waitForLiveDemand(
  harness: FrondTestHarness,
  projection: MobXNode<Record<string, never>, object, RatesResult, FineRatesNode>,
  expected: NodeLiveDemandSnapshot,
  changedEventIndex: number
): Promise<void> {
  await harness.waitForEvent(
    (record) => isMatchingLiveDemandEvent(record, projection.node.nodeId, expected),
    { description: `live demand ${changedEventIndex}` }
  );
  await projection.sync();
  expect(projection.snapshot?.liveDemand).toEqual(expected);
}

function isMatchingLiveDemandEvent(
  record: RuntimeEventRecord,
  nodeId: string,
  expected: NodeLiveDemandSnapshot
): boolean {
  return (
    record.event._tag === "GraphNodeLiveDemandChanged" &&
    record.event.nodeId === nodeId &&
    JSON.stringify(record.event.liveDemand) === JSON.stringify(expected)
  );
}
