import "./setup";
import { afterEach, expect, test } from "bun:test";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "@frondruntime/core";
import { act, cleanup, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import { StrictMode, Suspense, useLayoutEffect } from "react";
import { FrondProvider, useNode, useNodes } from "../src";

type MeasurementSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

function measurementNode(label: string, acquire: () => Promise<string>) {
  return class MeasurementNode extends NodeBase<MeasurementSpec> {
    static readonly spec = resourceSpec.async<MeasurementSpec>({
      tag: `react/suspend-count/${label}`,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(acquire),
    });
  };
}

type Scenario = "macrotask" | "microtask" | "preloaded" | "remount" | "staggered" | "strict";

async function measure(scenario: Scenario) {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<string>());
  const nodes = gates.map((gate, index) =>
    measurementNode(`${scenario}-${index}`, () =>
      scenario === "microtask" || scenario === "preloaded" || scenario === "remount"
        ? Promise.resolve(`ready-${index}`)
        : gate.promise
    )
  );
  const [First, Second, Third] = nodes;
  if (First === undefined || Second === undefined || Third === undefined) {
    throw new Error("Measurement requires three node classes.");
  }
  const counts = { entries: 0, completed: 0, fallbacks: 0, fallbackCommits: 0 };
  const SingleReader = observer(function SingleReader() {
    counts.entries += 1;
    const node = useNode(First, {});
    const result = node.result;
    counts.completed += 1;
    return <output>{result}</output>;
  });
  const CompositeReader = observer(function CompositeReader() {
    counts.entries += 1;
    const ready = useNodes({
      first: [First, {}],
      second: [Second, {}],
      third: [Third, {}],
    });
    const result = `${ready.first.result}/${ready.second.result}/${ready.third.result}`;
    counts.completed += 1;
    return <output>{result}</output>;
  });
  function Fallback() {
    counts.fallbacks += 1;
    useLayoutEffect(() => {
      counts.fallbackCommits += 1;
    }, []);
    return <span>loading</span>;
  }
  const Reader = scenario === "staggered" ? CompositeReader : SingleReader;
  const tree = (
    <FrondProvider runtime={runtime}>
      <Suspense fallback={<Fallback />}>
        <Reader />
      </Suspense>
    </FrondProvider>
  );
  const element = scenario === "strict" ? <StrictMode>{tree}</StrictMode> : tree;
  const firstHandle = runtime.client.node(First, {});
  if (scenario === "preloaded") {
    await firstHandle.ensureReady();
  }
  let view = await act(async () => render(element));
  if (scenario === "staggered") {
    for (let index = 0; index < nodes.length; index += 1) {
      const Node = nodes[index];
      const gate = gates[index];
      if (Node === undefined || gate === undefined) throw new Error("Missing measurement gate.");
      await act(async () => {
        // Each acquire settles in a separate macrotask, in a fixed order.
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            gate.resolve(`ready-${index}`);
            resolve();
          }, 0);
        });
        await runtime.client.node(Node, {}).ensureReady();
      });
    }
  } else {
    await act(async () => {
      if (scenario === "macrotask" || scenario === "strict") {
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            gates[0]?.resolve("ready-0");
            resolve();
          }, 0);
        });
      }
      await firstHandle.ensureReady();
    });
  }
  expect(
    view.getByText(scenario === "staggered" ? "ready-0/ready-1/ready-2" : "ready-0")
  ).toBeTruthy();
  if (scenario === "remount") {
    view.unmount();
    counts.entries = 0;
    counts.completed = 0;
    counts.fallbacks = 0;
    counts.fallbackCommits = 0;
    view = await act(async () => render(element));
    expect(view.getByText("ready-0")).toBeTruthy();
  }
  return {
    suspends: counts.entries - counts.completed,
    fallbacks: counts.fallbacks,
    fallbackCommits: counts.fallbackCommits,
  };
}

for (const scenario of [
  "macrotask",
  "microtask",
  "preloaded",
  "remount",
  "staggered",
  "strict",
] as const) {
  test(`Suspense counts: ${scenario}`, async () => {
    const counts = await measure(scenario);
    console.log(`suspend-count ${scenario}: ${JSON.stringify(counts)}`);
    const expected = {
      macrotask: { suspends: 2, fallbacks: 1, fallbackCommits: 1 },
      microtask: { suspends: 1, fallbacks: 1, fallbackCommits: 1 },
      preloaded: { suspends: 0, fallbacks: 0, fallbackCommits: 0 },
      remount: { suspends: 0, fallbacks: 0, fallbackCommits: 0 },
      staggered: { suspends: 2, fallbacks: 1, fallbackCommits: 1 },
      strict: { suspends: 2, fallbacks: 2, fallbackCommits: 2 },
    };
    expect(counts).toEqual(expected[scenario]);
  });
}
