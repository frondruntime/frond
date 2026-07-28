# @frondruntime/hub

A local devtools daemon. Frond runtimes attach to it and stream their event history in; a coding agent reads that history — and the graph as it stands right now — back out over MCP.

## Run

```sh
bunx @frondruntime/hub
```

**Bun, not Node.** This package ships as TypeScript source rather than a bundle: its bin is `src/cli.tsx` behind a `#!/usr/bin/env bun` shebang, and it renders with Ink. `bunx` runs it. `npx` does not — Node reaches the `.tsx` and dies on a parse error that says nothing about why, which is the worst way to learn about a runtime requirement. Whatever starts the hub has to start it with Bun.

It binds `127.0.0.1:17391` and takes over the terminal with a dashboard of attached runtimes. `--host` and `--port` override the defaults, but the port is worth leaving alone: apps hardcode it, and a hub somewhere else looks from the app's side exactly like a hub that is not running. `--version` reports the hub binary's version, which is not the protocol version the two halves have to agree on — see [Version mismatches](#version-mismatches).

A port collision is fatal rather than silently resolved, for the same reason.

The dashboard takes `↑↓` to move the cursor, `p` to pause the feed, `/` to filter, and `q` to quit. Keys are live only on a terminal: with stdin redirected the dashboard still renders and stops accepting input, rather than failing on a raw-mode request the stream cannot serve.

While it runs, it writes `.frond/hub-<port>.json` in the working directory and removes it on exit. `readHubLock` from `@frondruntime/devtools/node` reads it.

## Attach an app

```ts
import { attachDevtools } from "@frondruntime/devtools";

if (import.meta.env.DEV) {
  attachDevtools({ runtime, name: "my-app" });
}
```

No URL and no credential: the socket is unauthenticated and the address is the default. Attaching never throws, never rejects, and returns before it connects, so the call is safe in an entry file — but guard it anyway, because a production build that dials whatever answers on loopback is not a devtools client.

The hub attaches to *itself* the same way, through the same public entry point, so the first row in the dashboard is always the hub and the client half is exercised end to end on every boot.

## Connect an agent

```sh
claude mcp add --transport http frond http://127.0.0.1:17391/mcp
```

Four tools, all read-only:

- `frond_list_runtimes` — what is attached, and how much history the hub still holds for each. Start here; the others take an `attachmentId` from it.
- `frond_read_events` — events oldest first, filterable by tag, category, severity, and nodeId, paged with `since`.
- `frond_read_work` — every event belonging to one `workId`, which is one whole acquire/refresh/action cascade. The tool for "what actually happened when that failed".
- `frond_read_state` — the graph as it is now, rather than how it got here. Omit `nodeId` for the whole topology; pass one to get that node with its result and the edges on either side of it.

Every event reply carries a `coverage` block, because the honest answer to "did anything else happen?" is often "yes, and the hub no longer has it". `evictedByHub` counts what the ring dropped; `droppedBySender` counts what the app dropped before sending. `oldestRetainedSequence` above 1 means history is missing from the front — normally just because the hub subscribed after the runtime started, but also after a reconnect, where `generation` above 0 is the tell.

## Reading state

A whole-graph read answers a topology question, and answering it with a few hundred node results would bury the topology under the values. So results are withheld from it entirely and appear only on a single-node read:

```json
{
  "capturedAt": 1738000000000,
  "sequence": 4412,
  "runtimeId": "runtime-1",
  "runtimeStatus": "running",
  "graphStatus": "running",
  "observedInputs": 3,
  "values": "shape",
  "nodes": [
    {
      "nodeId": "smoke/config:v1:\"singleton\"",
      "tag": "smoke/config",
      "kind": "service",
      "state": "Ready",
      "revision": 3,
      "status": "Wired{_tag,run}",
      "liveDemand": "{isLive,sources,scopes}",
      "operation": "Idle{_tag}"
    }
  ],
  "edges": [
    {
      "from": "smoke/feed:v1:{\"region\":\"eu-west\",\"topic\":\"orders\"}",
      "to": "smoke/config:v1:\"singleton\"",
      "dependency": "config"
    }
  ]
}
```

A `nodeId` is `tag:key`, which is why it reads like a fragment of JSON with a tag stuck to the front — the key half is the canonical encoding of that node's identity, and quoting it back is how you ask about that one node. `state` is the arm every reader branches on; `revision` is core's per-node write counter, the cheap way to tell "still the value I saw" from "recomputed to something that looks the same". Edges run from the dependent to its dependency, named by the slot the dependent declared.

Pass that `nodeId` back to get the node itself, its result, and every edge touching it in either direction — "what does this depend on" and "what breaks if this does" being the same question asked twice. The node entry from that reply, on an app that has opted into `full`:

```json
{
  "nodeId": "smoke/config:v1:\"singleton\"",
  "tag": "smoke/config",
  "kind": "service",
  "state": "Ready",
  "revision": 3,
  "result": { "failureRate": 0.18, "baseLatencyMs": 40 }
}
```

Line a snapshot up against the event log using `capturedAt` and `sequence`: the latter is the last event the runtime had emitted when the snapshot was taken, so a `frond_read_events` page and a `frond_read_state` reply are two accounts of one system rather than two systems.

## The value policy

`none < shape < full`. The hub asks for `full` on every state read and takes what it is given: an attached app declares a ceiling that **defaults to `shape`**, and the lower of the two is what actually crosses. The common outcome is therefore that real values never leave the app.

That is the intended arrangement rather than a gap in it. The decision to put an application's real values on a socket belongs to the app that owns them, not to the tool reading them — and the runtimes worth attaching devtools to are exactly the ones holding tokens and account state.

At `shape`, a value arrives as a one-line descriptor of itself: `Wired{_tag,run}`, `string[42]`, `Map(3)`, `{failureRate,baseLatencyMs}`. Enough to see the structure of a graph, never enough to read what is in it — which is why the whole-graph read above shows descriptors where the single-node read, against an app that raised its ceiling, shows the value.

Every snapshot reports the policy it was actually built under, in its own `values` field, because a reader that finds no `result` on a node has to be able to tell "redacted" from "not ready" — those are the same absence otherwise. `frond_list_runtimes` reports each app's declared ceiling in the same field. What each policy sends, in detail, is in the [devtools README](../../packages/devtools/README.md).

## Which attachment a call reads

Every read takes an optional `attachmentId`. Omitted, the hub resolves one, and the rules are worth knowing because the interesting case used to be silent:

- **One app attached** — that one, with no round trip. Making the common case cost an extra call is how a tool ends up unused.
- **Only the hub attached** — a refusal that says how to attach an app, and gives the hub's own attachment id for reading the hub anyway. The hub is always in the list, so it would otherwise be the sole candidate on an idle machine, and answering "what does my graph look like" with the devtools' own graph is a wrong answer wearing the shape of a right one.
- **Several apps** — an error naming every candidate, so the next call can be right. A guess the caller cannot see is worse than a question it can answer.

Naming the hub's own attachment id explicitly still resolves. Inspecting the hub is a real thing to want; only the accidental case was the bug.

Refusals come back as ordinary results tagged `McpReadError`, not as MCP errors. Raising would render each one through `Cause.pretty` and spend the caller's context window on six stack frames that are about Effect rather than about the mistake.

## Version mismatches

The two halves must agree on `HUB_PROTOCOL_VERSION` exactly. There is no capability negotiation, because a partial mismatch presents as "the runtime stopped emitting" — an app that cannot decode a command it has never heard of drops its socket, and that is the most expensive way this can fail.

So the hub refuses outright, in one line naming both numbers and which side is behind, and the app prints that line and stops. It does not keep dialing: every retry would send the same version and earn the same answer. A refusal is terminal and loud, where every other attach failure is retried and quiet.

## Restarts

Nothing here is durable, deliberately. An app that loses the hub retries every two seconds and comes back as the same `instanceId` with `generation` bumped, but the events it emitted while disconnected are gone, and stopping the hub discards every retained ring. That is the intended shape of a tool you point at a process you are actively working on — if you need history that survives a restart, you need a sink, not a devtools hub.

## Security

Unauthenticated on both paths, deliberately and only for local development. The hub binds loopback and the attach socket carries data one way, so the worst an uninvited local caller does is put junk in a dashboard — but that junk then reaches an agent through MCP. Records are not proof of their own origin: a reader that treats a record's `tag` or `fields` as instructions rather than as data is trusting whatever managed to open a socket.

MCP is also the direction in which app data leaves, which is what the value policy is for. That policy is enforced by the app rather than by the hub, so an app's ceiling holds no matter what the endpoint asks for.

Do not point this at production data, and do not expose the port beyond loopback.

## Develop

```sh
bun --conditions=source apps/hub/src/cli.tsx
bun --conditions=source test apps/hub/test
bun --conditions=source apps/hub/smoke/readState.ts
```

The smoke script is the end-to-end check for `frond_read_state`: a hub, two apps, and an MCP client in one process, over real websockets and real HTTP, asserting on which attachment each call resolves to. It listens beside the default port so it can run while a development hub holds 17391.

The hub is itself a Frond app — canonical nodes, an Ink UI built on `@frondruntime/react` — so it reports on itself with no special-casing. `isHubInternal` is the one exception: it drops records whose nodes are all `hub/`-prefixed, without which applying a batch would emit the events that make up the next batch.

## AI use

Frond is AI-assisted (mainly Claude and Codex), iterated over months rather than one-shot generated. Full note: https://frondruntime.dev/ai-use
