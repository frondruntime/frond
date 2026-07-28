/**
 * The end-to-end check for `frond_read_state`, over real MCP.
 *
 * The other half of `app.ts`: same fixture graph, but driven once and asserted
 * on instead of stirred forever. It runs a hub, an app, and an MCP client in one
 * process — not to be tidy, but because half of what is under test is *which*
 * attachment a call resolves to, and that question only exists when the hub's
 * own self-attachment is sitting in the list next to the app's. A check pointed
 * at a hub someone else started could not stage that.
 *
 * Everything crosses the wire it would in real use: a websocket for the attach,
 * an HTTP POST per MCP call, JSON both ways. Nothing reaches into the hub's
 * state directly, because a reader that did would pass while the transport was
 * broken.
 *
 *   bun --conditions=source apps/hub/smoke/readState.ts
 *
 * Exits non-zero on the first failed expectation's account, so it is usable as a
 * gate. Defaults to a port beside the hub's own, so it can run while a
 * development hub holds 17391.
 */
import { Args, createRuntime } from "@frondruntime/core";
import { attachDevtools, HUB_DEFAULT_HOST, HUB_DEFAULT_PORT } from "@frondruntime/devtools";
import { isHubInternal } from "../src/hubInternal.ts";
import { MCP_PATH } from "../src/mcp.ts";
import { HubServerNode } from "../src/nodes/hubServer.ts";
import { CONFIG_RESULT, ConfigNode, FeedNode, sleep } from "./nodes.ts";

/**
 * Beside the hub's default rather than on it.
 *
 * A check that stole 17391 would fail on the machine of anyone who left a hub
 * running, which is every machine this check is worth running on.
 */
const DEFAULT_PORT = HUB_DEFAULT_PORT + 100;

/** Long enough for an attach and a first snapshot; short enough to be a bug. */
const WAIT_TIMEOUT_MS = 10_000;

const options = parseArgs(process.argv.slice(2));

const endpoint = `http://${options.host}:${options.port}${MCP_PATH}`;

/* ------------------------------------------------------------ expectations */

let failed = 0;

/**
 * One expectation, reported whether it held or not.
 *
 * Passes are printed too. A check that only speaks up on failure cannot be told
 * apart from a check that never ran, and "it printed nothing" is exactly what a
 * smoke script that died on line one also does.
 */
function expect(what: string, ok: boolean, detail?: string): void {
  const label = ok ? "ok  " : "FAIL";

  console.log(`[read-state] ${label} ${what}${detail === undefined ? "" : ` — ${detail}`}`);

  if (!ok) {
    failed += 1;
  }
}

/** Nothing to say rather than an empty aside, on the expectation that held. */
function listed(names: ReadonlyArray<string>): string | undefined {
  return names.length === 0 ? undefined : names.join(", ");
}

/**
 * Whether a message names every one of these.
 *
 * Fragments rather than the whole string, because what is being asserted is that
 * the error tells the agent where to go next — the ids and the call it should
 * make — and pinning the prose around them would make every future rewording a
 * failing check.
 */
function mentions(text: string | undefined, ...fragments: ReadonlyArray<string>): boolean {
  return text !== undefined && fragments.every((fragment) => text.includes(fragment));
}

/* -------------------------------------------------------------- mcp client */

/**
 * The wire shapes, declared rather than indexed into.
 *
 * Narrower than what actually crosses — a snapshot has a dozen more fields — and
 * deliberately so: this is a description of what the check reads, and widening
 * it to mirror `protocol.ts` would only give the two something to disagree
 * about. Everything is optional because a tool call can come back as a refusal
 * instead, which is a different shape entirely.
 */
type ToolReply = {
  readonly _tag?: string;
  readonly message?: string;
};

type EncodedNode = {
  readonly nodeId: string;
  readonly tag: string;
  /** Present as a key or not at all — never `null`. See the read below. */
  readonly result?: unknown;
};

type EncodedEdge = {
  readonly from: string;
  readonly to: string;
};

type Snapshot = ToolReply & {
  readonly values?: string;
  readonly nodes?: ReadonlyArray<EncodedNode>;
  readonly edges?: ReadonlyArray<EncodedEdge>;
};

type RuntimeRow = {
  readonly attachmentId: string;
  readonly name: string;
  readonly isHub: boolean;
};

type RuntimeList = ToolReply & {
  readonly runtimes?: ReadonlyArray<RuntimeRow>;
};

type RpcEnvelope = {
  readonly result?: unknown;
  readonly error?: unknown;
};

/**
 * The MCP session, learned from the first response rather than invented.
 *
 * Each POST is its own RPC client to the server, so the `Mcp-Session-Id` header
 * is the only thing tying the `initialize` to every call after it. Dropping it
 * gets a 404 with no body, which reads like a routing mistake.
 */
let sessionId: string | undefined;

let nextRequestId = 0;

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  nextRequestId += 1;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };

  if (sessionId !== undefined) {
    headers["mcp-session-id"] = sessionId;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: String(nextRequestId), method, params }),
  });

  const issued = response.headers.get("mcp-session-id");

  if (issued !== null) {
    sessionId = issued;
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${method} → HTTP ${response.status} ${text}`);
  }

  const body: unknown = JSON.parse(text);
  // A batched POST answers with an array even when it carried one request, so
  // both framings are unwrapped here rather than assumed.
  const message = (Array.isArray(body) ? body[0] : body) as RpcEnvelope;

  if (message.error !== undefined) {
    throw new Error(`${method} → ${JSON.stringify(message.error)}`);
  }

  return message.result;
}

/**
 * The handshake, which is not optional.
 *
 * Every call after this one is refused with a bare `404` until it has happened —
 * no body, no message — so skipping it looks like a routing bug rather than a
 * protocol one. The server upgrades an unrecognized version to its own latest,
 * so this constant is a floor and not a pin.
 */
async function initialize(): Promise<void> {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "frond-smoke-read-state", version: "0" },
  });
}

/**
 * Calls a tool and hands back what the tool itself returned.
 *
 * The hub's tools use `failureMode: "return"`, so a refusal is an ordinary
 * result with a `_tag` on it, not an MCP error. Unwrapping both to the same
 * value is what lets a caller assert on the refusal's text — which for this tool
 * is half the contract.
 */
async function callTool<A extends ToolReply>(
  name: string,
  args: Record<string, unknown>
): Promise<A> {
  const result = (await rpc("tools/call", { name, arguments: args })) as {
    readonly content?: ReadonlyArray<{ readonly text?: string }>;
  };
  const text = result.content?.[0]?.text;

  if (text === undefined) {
    throw new Error(`${name} returned no content: ${JSON.stringify(result)}`);
  }

  return JSON.parse(text) as A;
}

function readError(reply: ToolReply): string | undefined {
  return reply._tag === "McpReadError" ? reply.message : undefined;
}

/* ------------------------------------------------------------------- graph */

function nodesOf(snapshot: Snapshot): ReadonlyArray<EncodedNode> {
  return snapshot.nodes ?? [];
}

function edgesOf(snapshot: Snapshot): ReadonlyArray<EncodedEdge> {
  return snapshot.edges ?? [];
}

async function waitFor(what: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`timed out waiting for ${what}`);
}

async function runtimeRows(): Promise<ReadonlyArray<RuntimeRow>> {
  const reply = await callTool<RuntimeList>("frond_list_runtimes", {});

  return reply.runtimes ?? [];
}

/* --------------------------------------------------------------- the check */

const hubRuntime = createRuntime();
await hubRuntime.submit({ _tag: "RuntimeStart" });

// Minted here and handed to both halves of the self-attachment, exactly as the
// CLI does: it is what lets the hub recognize its own row, and recognizing that
// row is the behavior under test in phase 1.
const selfInstanceId = crypto.randomUUID();

const server = await hubRuntime.client
  .node(HubServerNode, {
    host: options.host,
    port: options.port,
    selfInstanceId,
  })
  .ensureReadyNode();

const attachUrl = server.result.attachUrl;

const detachHub = attachDevtools({
  runtime: hubRuntime,
  url: attachUrl,
  name: "frond-hub",
  platform: "bun",
  values: "full",
  instanceId: selfInstanceId,
  include: (record) => !isHubInternal(record),
});

console.log(`[read-state] hub on ${options.host}:${options.port}, mcp at ${endpoint}`);

const apps: Array<{ readonly detach: () => void; readonly stop: () => Promise<unknown> }> = [];

/** Attaches another app to the hub, `"full"` so real values can be asserted on. */
async function startApp(name: string) {
  const runtime = createRuntime();
  await runtime.submit({ _tag: "RuntimeStart" });

  const detach = attachDevtools({
    runtime,
    url: attachUrl,
    name,
    platform: "bun",
    values: "full",
    onError: (cause) => {
      console.error(`[read-state] ${name} attach:`, cause);
    },
  });

  apps.push({
    detach,
    stop: () => runtime.submit({ _tag: "RuntimeStop", reason: "read-state check" }),
  });

  return runtime;
}

try {
  /* -- phase 1: the hub is the only attachment ---------------------------- */

  await initialize();

  await waitFor("the hub's self-attachment", async () => (await runtimeRows()).length === 1);

  const hubRow = (await runtimeRows())[0];
  const hubAttachmentId = hubRow === undefined ? "" : hubRow.attachmentId;

  expect("the hub's own row is marked isHub", hubRow?.isHub === true);

  const unnamed = await callTool<Snapshot>("frond_read_state", {});
  const refusal = readError(unnamed);

  expect(
    "an unnamed read refuses rather than answering about the hub",
    refusal !== undefined,
    refusal ?? JSON.stringify(unnamed).slice(0, 120)
  );
  expect(
    "the refusal says how to attach an app and how to read the hub anyway",
    mentions(refusal, "attachDevtools", hubAttachmentId)
  );

  const named = await callTool<Snapshot>("frond_read_state", { attachmentId: hubAttachmentId });

  expect(
    "naming the hub explicitly still reads the hub",
    readError(named) === undefined && nodesOf(named).some((node) => node.tag.startsWith("hub/")),
    readError(named)
  );

  /* -- phase 2: one app, so an unnamed read has an obvious answer ---------- */

  const appRuntime = await startApp("smoke-read-state");

  await waitFor("the app's attachment", async () => (await runtimeRows()).length === 2);

  // Ensured rather than merely constructed: `FeedNode` pulls `ConfigNode` and
  // `SessionNode` in behind it, which is what puts edges in the snapshot. Its
  // own acquire fails ~18% of the time by design and that is fine — the deps
  // are ready either way, and the check below reads one of those.
  await appRuntime.client.node(FeedNode, { topic: "orders", region: "eu-west" }).ensure();
  await appRuntime.client.node(ConfigNode, Args.none).ensureReadyNode();

  const graph = await callTool<Snapshot>("frond_read_state", {});
  const graphNodes = nodesOf(graph);
  const config = graphNodes.find((node) => node.tag === "smoke/config");

  expect(
    "an unnamed read now resolves to the only app, not the hub",
    readError(graph) === undefined && graphNodes.every((node) => !node.tag.startsWith("hub/")),
    readError(graph)
  );
  expect("the whole-graph read carries the fixture nodes", config !== undefined);
  expect("the whole-graph read carries edges", edgesOf(graph).length > 0);
  // Absence, not `null`: these fields cross as `Schema.optional`, which encodes
  // an explicit `undefined` as `null` — so a snapshot that withheld results by
  // setting them undefined would still answer `"result" in node`.
  expect(
    "no node in a whole-graph read carries a result",
    graphNodes.every((node) => !("result" in node)),
    listed(graphNodes.filter((node) => "result" in node).map((node) => node.nodeId))
  );
  expect(
    "the whole-graph read reports the policy that was applied",
    graph.values === "full",
    graph.values
  );

  const configId = config === undefined ? "" : config.nodeId;

  const single = await callTool<Snapshot>("frond_read_state", { nodeId: configId });
  const singleNode = nodesOf(single)[0];

  expect("a single-node read returns exactly that node", nodesOf(single).length === 1);
  expect(
    "a single-node read carries the result",
    singleNode !== undefined && "result" in singleNode
  );
  expect(
    "the result is the real value at the full policy",
    JSON.stringify(singleNode?.result) === JSON.stringify(CONFIG_RESULT),
    JSON.stringify(singleNode?.result)
  );
  expect(
    "a single-node read carries the edges on either side of it",
    edgesOf(single).length > 0 &&
      edgesOf(single).every((edge) => edge.from === configId || edge.to === configId)
  );

  const shaped = await callTool<Snapshot>("frond_read_state", {
    nodeId: configId,
    values: "shape",
  });
  const shapedNode = nodesOf(shaped)[0];

  expect(
    "an explicit values policy is applied and reported",
    shaped.values === "shape",
    shaped.values
  );
  // Asserted as "not the data" rather than against a particular descriptor: how
  // a redacted value renders is the encoder's business and moves.
  expect(
    "the shaped read describes the value instead of sending it",
    shapedNode !== undefined &&
      "result" in shapedNode &&
      JSON.stringify(shapedNode.result) !== JSON.stringify(CONFIG_RESULT),
    JSON.stringify(shapedNode?.result)
  );

  const missing = await callTool<Snapshot>("frond_read_state", { nodeId: "smoke/nope:v1" });
  const missingError = readError(missing);

  expect(
    "an unknown nodeId comes back as a message, not a crash",
    missingError !== undefined,
    missingError ?? JSON.stringify(missing).slice(0, 120)
  );
  expect(
    "the unknown-node message points at the next call",
    mentions(missingError, "smoke/nope:v1", "frond_read_state without nodeId"),
    missingError
  );

  /* -- phase 3: two apps, so there is no obvious answer -------------------- */

  await startApp("smoke-read-state-2");
  await waitFor("the second app's attachment", async () => (await runtimeRows()).length === 3);

  const ambiguous = await callTool<Snapshot>("frond_read_state", {});
  const ambiguousError = readError(ambiguous);

  expect(
    "an unnamed read with two apps lists them rather than guessing",
    mentions(ambiguousError, "smoke-read-state", "smoke-read-state-2"),
    ambiguousError ?? JSON.stringify(ambiguous).slice(0, 120)
  );
} catch (cause) {
  failed += 1;
  console.error("[read-state] threw:", cause);
} finally {
  for (const app of apps) {
    app.detach();
    await app.stop();
  }

  detachHub();
  await hubRuntime.submit({ _tag: "RuntimeStop", reason: "read-state check" });
}

console.log(`[read-state] ${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);

process.exit(failed === 0 ? 0 : 1);

/* ------------------------------------------------------------------- flags */

type Options = {
  readonly host: string;
  readonly port: number;
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

  return {
    host: flags.get("host") ?? HUB_DEFAULT_HOST,
    port: Number(flags.get("port") ?? String(DEFAULT_PORT)),
  };
}
