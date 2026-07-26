import { projectError } from "../diagnostics";
import type {
  DependenciesRecord,
  FrondNode,
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecDeclaredDeps,
  NodeSpecInstance,
  NodeSpecLike,
  NodeSpecMode,
  NodeSpecResult,
  ResolvedDeps,
} from "../node";
import type {
  Runtime,
  RuntimeClient,
  RuntimeEventRecord,
  RuntimeNodeHandle,
  RuntimeNodeRead,
  RuntimeWorkMetadata,
} from "../runtime";
import { type CapturingRuntimeSink, createTestRuntime, type TestRuntimeOptions } from "./runtime";

export interface FrondTestHarnessOptions extends TestRuntimeOptions {
  readonly waitTimeoutMs?: number | undefined;
  readonly waitIntervalMs?: number | undefined;
}

// Phantom spec brand. A test handle is a runtime handle that also remembers the
// node spec it was opened for, so `readReady`/`readError` can recover the node
// instance, deps, and result types instead of collapsing them to `object`. The
// symbol is type-only; nothing is attached at runtime.
declare const FROND_TEST_SPEC: unique symbol;

export interface FrondTestNodeHandle<TSpec extends NodeSpecLike>
  extends RuntimeNodeHandle<
    NodeSpecArgs<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>,
    NodeSpecMode<TSpec>,
    NodeSpecInstance<TSpec> & object
  > {
  readonly [FROND_TEST_SPEC]?: TSpec;
}

export interface FrondTestHarness {
  readonly runtime: Runtime;
  readonly client: RuntimeClient;
  readonly sink: CapturingRuntimeSink;
  readonly events: ReadonlyArray<RuntimeEventRecord>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly teardown: () => Promise<void>;
  readonly node: <TSpec extends NodeSpecLike>(
    spec: TSpec,
    args: NodeSpecArgs<TSpec>
  ) => FrondTestNodeHandle<TSpec>;
  readonly startNode: <TSpec extends NodeSpecLike>(
    spec: TSpec,
    args: NodeSpecArgs<TSpec>
  ) => Promise<
    NodeSpecInstance<TSpec> &
      FrondNode<
        NodeSpecArgs<TSpec>,
        ResolvedDeps<NodeSpecDeclaredDeps<TSpec>>,
        NodeSpecResult<TSpec>
      >
  >;
  readonly startNodes: <TMap extends FrondTestNodeInputMap>(
    map: TMap
  ) => Promise<FrondTestReadyNodeMap<TMap>>;
  /**
   * Ready-or-throw over a test handle, returning the full Ready READ (not just
   * the node) with spec-typed deps/result access via `FrondTestReadyRead`.
   *
   * The public handle now carries its own ready-or-throw method —
   * `handle.readReady()` returns only the typed node instance and throws the
   * typed `FrondNodeNotReady` for non-ready phases. This harness helper remains
   * for tests that need the spec-typed read surface (node with `deps`,
   * `result`, `resultValidity`) and the harness's diagnostic error messages; it
   * intentionally does not delegate because its return shape and error texts
   * are part of the testing contract.
   */
  readonly readReady: <TSpec extends NodeSpecLike>(
    handle: FrondTestNodeHandle<TSpec>
  ) => FrondTestReadyRead<
    NodeSpecArgs<TSpec>,
    NodeSpecDeclaredDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecInstance<TSpec>
  >;
  readonly readError: <TSpec extends NodeSpecLike>(
    handle: FrondTestNodeHandle<TSpec>
  ) => Extract<RuntimeNodeRead<NodeSpecResult<TSpec>>, { readonly _tag: "Error" }>;
  readonly waitForEvent: (
    predicate: (record: RuntimeEventRecord) => boolean,
    options?: FrondTestWaitOptions | undefined
  ) => Promise<RuntimeEventRecord>;
  readonly waitForNodeRead: <TArgs, TResult>(
    handle: RuntimeNodeHandle<TArgs, TResult>,
    predicate: (read: RuntimeNodeRead<TResult>) => boolean,
    options?: FrondTestWaitOptions | undefined
  ) => Promise<RuntimeNodeRead<TResult>>;
  readonly waitForIdle: (options?: FrondTestWaitOptions | undefined) => Promise<void>;
}

export interface FrondTestWaitOptions {
  readonly timeoutMs?: number | undefined;
  readonly intervalMs?: number | undefined;
  readonly description?: string | undefined;
}

type NormalizedWaitOptions = {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly description?: string | undefined;
};

export interface FrondTestNodeInput<TSpec extends NodeSpecLike> {
  readonly spec: TSpec;
  readonly args: NodeSpecArgs<TSpec>;
}

export type FrondTestNodeInputMap = Readonly<Record<string, FrondTestNodeInput<NodeSpecLike>>>;

export type FrondTestReadyNodeMap<TMap extends FrondTestNodeInputMap> = {
  readonly [K in keyof TMap]: TMap[K] extends FrondTestNodeInput<infer TSpec>
    ? NodeSpecNode<TSpec> &
        FrondNode<NodeSpecArgs<TSpec>, ResolvedDeps<NodeSpecDeps<TSpec>>, NodeSpecResult<TSpec>>
    : never;
};

export type FrondTestReadyRead<
  TArgs,
  TDeps extends DependenciesRecord,
  TResult,
  TNode extends object,
> = Omit<Extract<RuntimeNodeRead<TResult>, { readonly _tag: "Ready" }>, "node"> & {
  readonly node: TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult>;
};

type NodeSpecDeps<TSpec> = NodeSpecDeclaredDeps<TSpec>;

type NodeSpecNode<TSpec> = NodeSpecInstance<TSpec>;

const defaultWaitTimeoutMs = 1000;
const defaultWaitIntervalMs = 1;

export type FrondTestRuntimeEventSource = Runtime | ReadonlyArray<RuntimeEventRecord>;

export type FrondTestRuntimeEventPredicate =
  | RuntimeEventRecord["event"]["_tag"]
  | ((record: RuntimeEventRecord) => boolean);

export function createFrondTestHarness(options: FrondTestHarnessOptions = {}): FrondTestHarness {
  const { waitTimeoutMs, waitIntervalMs, ...runtimeOptions } = options;
  const runtime = createTestRuntime(runtimeOptions);
  const waitDefaults: NormalizedWaitOptions = {
    timeoutMs: normalizeWaitMillis(waitTimeoutMs, defaultWaitTimeoutMs, "waitTimeoutMs"),
    intervalMs: normalizeWaitMillis(waitIntervalMs, defaultWaitIntervalMs, "waitIntervalMs"),
  };
  let tornDown = false;

  const harness: FrondTestHarness = {
    runtime: runtime.runtime,
    client: runtime.client,
    sink: runtime.sink,
    events: runtime.events,
    start: async () => {
      await runtime.runtime.submit({
        _tag: "RuntimeStart",
        metadata: testWork("start", "blocking"),
      });
    },
    stop: async () => {
      await runtime.runtime.submit({
        _tag: "RuntimeStop",
        reason: "test stop",
        metadata: testWork("stop", "blocking"),
      });
    },
    teardown: async () => {
      if (tornDown) {
        return;
      }

      tornDown = true;
      await runtime.runtime.submit({
        _tag: "RuntimeStop",
        reason: "test teardown",
        metadata: testWork("stop", "blocking"),
      });
    },
    node: <TSpec extends NodeSpecLike>(spec: TSpec, args: NodeSpecArgs<TSpec>) =>
      runtime.client.node(spec, args) as FrondTestNodeHandle<TSpec>,
    startNode: async <TSpec extends NodeSpecLike>(spec: TSpec, args: NodeSpecArgs<TSpec>) => {
      const handle = harness.node(spec, args);
      await handle.ensureReady(testWork("readiness", "blocking"));
      return harness.readReady(handle).node;
    },
    startNodes: async (map) => {
      const entries = await Promise.all(
        Object.entries(map).map(async ([key, input]) => [
          key,
          await harness.startNode(input.spec, input.args),
        ])
      );

      return Object.fromEntries(entries) as FrondTestReadyNodeMap<typeof map>;
    },
    readReady: <TSpec extends NodeSpecLike>(handle: FrondTestNodeHandle<TSpec>) => {
      const read = handle.read();

      if (read._tag !== "Ready") {
        if (read._tag === "Error") {
          const projection = projectError(read.error);

          throw new Error(
            `Expected Frond test node read Ready, received Error: ${projection.rootTag}: ${projection.rootMessage}.`,
            { cause: read.error }
          );
        }

        throw new Error(`Expected Frond test node read Ready, received ${read._tag}.`);
      }

      return read as unknown as FrondTestReadyRead<
        NodeSpecArgs<TSpec>,
        NodeSpecDeclaredDeps<TSpec>,
        NodeSpecResult<TSpec>,
        NodeSpecInstance<TSpec>
      >;
    },
    readError: <TSpec extends NodeSpecLike>(handle: FrondTestNodeHandle<TSpec>) => {
      const read = handle.read();

      if (read._tag !== "Error") {
        throw new Error(`Expected Frond test node read Error, received ${read._tag}.`);
      }

      return read as Extract<RuntimeNodeRead<NodeSpecResult<TSpec>>, { readonly _tag: "Error" }>;
    },
    waitForEvent: (predicate, waitOptions) =>
      waitForRuntimeEvent(
        runtime.events,
        predicate,
        normalizeWaitOptions(waitDefaults, waitOptions)
      ),
    waitForNodeRead: (handle, predicate, waitOptions) =>
      waitForRuntimeNodeRead(handle, predicate, normalizeWaitOptions(waitDefaults, waitOptions)),
    waitForIdle: (waitOptions) =>
      waitForIdle(runtime.runtime, runtime.events, normalizeWaitOptions(waitDefaults, waitOptions)),
  };

  return harness;
}

function testWork(
  reason: RuntimeWorkMetadata["reason"],
  priority: RuntimeWorkMetadata["priority"]
): RuntimeWorkMetadata {
  return {
    source: "test",
    reason,
    priority,
  };
}

function normalizeWaitOptions(
  defaults: NormalizedWaitOptions,
  options: FrondTestWaitOptions | undefined
): NormalizedWaitOptions {
  return {
    timeoutMs: normalizeWaitMillis(options?.timeoutMs, defaults.timeoutMs, "timeoutMs"),
    intervalMs: normalizeWaitMillis(options?.intervalMs, defaults.intervalMs, "intervalMs"),
    description: options?.description,
  };
}

function normalizeWaitMillis(
  value: number | undefined,
  defaultValue: number,
  field: string
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Frond test harness ${field} must be a finite non-negative number.`);
  }

  return value;
}

export async function waitForRuntimeEvent(
  source: FrondTestRuntimeEventSource,
  predicate: FrondTestRuntimeEventPredicate,
  options: FrondTestWaitOptions = {}
): Promise<RuntimeEventRecord> {
  const matches = await waitForRuntimeEventCount(source, predicate, 1, options);
  const record = matches[0];

  if (record === undefined) {
    throw new Error("Expected waitForRuntimeEventCount to return one record.");
  }

  return record;
}

export async function waitForRuntimeEventCount(
  source: FrondTestRuntimeEventSource,
  predicate: FrondTestRuntimeEventPredicate,
  count: number,
  options: FrondTestWaitOptions = {}
): Promise<ReadonlyArray<RuntimeEventRecord>> {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("Frond test runtime event count must be a non-negative integer.");
  }

  const normalizedOptions = normalizeWaitOptions(
    {
      timeoutMs: defaultWaitTimeoutMs,
      intervalMs: defaultWaitIntervalMs,
    },
    options
  );
  const isMatch = runtimeEventPredicate(predicate);
  const startedAt = performance.now();
  const matches: Array<RuntimeEventRecord> = [];
  // Track the highest sequence already scanned so each poll only inspects newly
  // appended events. Keyed by sequence (not index) to stay correct when the
  // bounded event buffer trims older records between polls.
  let lastScannedSequence = 0;
  let events = await readRuntimeEvents(source);

  while (true) {
    for (const record of events) {
      if (record.sequence > lastScannedSequence) {
        lastScannedSequence = record.sequence;

        if (isMatch(record)) {
          matches.push(record);
        }
      }
    }

    if (matches.length >= count) {
      return matches;
    }

    if (performance.now() - startedAt > normalizedOptions.timeoutMs) {
      break;
    }

    await sleep(normalizedOptions.intervalMs);
    events = await readRuntimeEvents(source);
  }

  throw new Error(
    `Timed out waiting for ${count} Frond runtime event(s)${waitDescription(normalizedOptions)}. Recent events: ${recentEvents(events)}.`
  );
}

export function waitForRuntimeNodeRead<TArgs, TResult>(
  handle: RuntimeNodeHandle<TArgs, TResult>,
  predicate: (read: RuntimeNodeRead<TResult>) => boolean,
  options: FrondTestWaitOptions = {}
): Promise<RuntimeNodeRead<TResult>> {
  const normalizedOptions = normalizeWaitOptions(
    {
      timeoutMs: defaultWaitTimeoutMs,
      intervalMs: defaultWaitIntervalMs,
    },
    options
  );

  return new Promise((resolve, reject) => {
    let latestRead = handle.read();
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const timeout = setTimeout(() => {
      fail(
        new Error(
          `Timed out waiting for Frond node read${waitDescription(normalizedOptions)}. Latest read: ${latestRead._tag}.`
        )
      );
    }, normalizedOptions.timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribe?.();
      unsubscribe = undefined;
    };
    const finish = (read: RuntimeNodeRead<TResult>) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(read);
    };
    const fail = (cause: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(cause);
    };
    const check = () => {
      try {
        latestRead = handle.read();

        if (predicate(latestRead)) {
          finish(latestRead);
        }
      } catch (cause) {
        fail(cause);
      }
    };

    try {
      unsubscribe = handle.subscribe(check);
      check();
    } catch (cause) {
      fail(cause);
    }
  });
}

async function readRuntimeEvents(
  source: FrondTestRuntimeEventSource
): Promise<ReadonlyArray<RuntimeEventRecord>> {
  if (isRuntimeEventRecordArray(source)) {
    return source;
  }

  const result = await source.query({ _tag: "RuntimeEvents" });

  if (result._tag !== "RuntimeEvents") {
    throw new Error(`Expected RuntimeEvents query, received ${result._tag}.`);
  }

  return result.events;
}

function isRuntimeEventRecordArray(
  source: FrondTestRuntimeEventSource
): source is ReadonlyArray<RuntimeEventRecord> {
  return Array.isArray(source);
}

function runtimeEventPredicate(
  predicate: FrondTestRuntimeEventPredicate
): (record: RuntimeEventRecord) => boolean {
  return typeof predicate === "string" ? (record) => record.event._tag === predicate : predicate;
}

async function waitForIdle(
  runtime: Runtime,
  events: ReadonlyArray<RuntimeEventRecord>,
  options: NormalizedWaitOptions
): Promise<void> {
  const startedAt = performance.now();
  // Each poll projects a full system snapshot, so don't poll faster than a small
  // floor even when the configured event-wait interval is tighter.
  const intervalMs = Math.max(options.intervalMs, 5);

  while (performance.now() - startedAt <= options.timeoutMs) {
    const snapshot = await runtime.getSnapshot();
    const busyNode = snapshot.graph.nodes.find(
      (node) =>
        node.operation._tag === "Running" ||
        (node.status._tag === "Wired" && node.status.run._tag === "Pending")
    );

    if (busyNode === undefined) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for Frond runtime idle${waitDescription(options)}. Recent events: ${recentEvents(events)}.`
  );
}

function waitDescription(options: Pick<FrondTestWaitOptions, "description">): string {
  return options.description === undefined ? "" : ` (${options.description})`;
}

function recentEvents(events: ReadonlyArray<RuntimeEventRecord>): string {
  const recent = events.slice(-10).map((record) => `#${record.sequence}:${record.event._tag}`);
  return recent.length === 0 ? "none" : recent.join(", ");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
