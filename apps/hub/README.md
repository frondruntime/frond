# frond-hub

A local devtools daemon. Frond runtimes attach to it and stream their event history in; a coding agent reads that history back out over MCP.

Not published. Run it from the repository.

## Run

```sh
bun --conditions=source apps/hub/src/cli.tsx
```

It binds `127.0.0.1:17391` and takes over the terminal with a dashboard of attached runtimes. `--host` and `--port` override the defaults, but the port is worth leaving alone: apps hardcode it, and a hub somewhere else looks from the app's side exactly like a hub that is not running.

A port collision is fatal rather than silently resolved, for the same reason.

While it runs, it writes `.frond/hub-<port>.json` in the working directory and removes it on exit. `readHubLock` from `@frondruntime/devtools/node` reads it.

## Attach an app

```ts
import { attachDevtools } from "@frondruntime/devtools";

if (import.meta.env.DEV) {
  attachDevtools({ runtime, name: "my-app" });
}
```

No URL and no credential: the socket is unauthenticated and the address is the default. See the [package README](../../packages/devtools/README.md) for what gets sent — values are redacted to `"shape"` unless the app says otherwise.

The hub attaches to *itself* the same way, through the same public entry point, so the first row in the dashboard is always the hub and the client half is exercised end to end on every boot.

## Connect an agent

```sh
claude mcp add --transport http frond http://127.0.0.1:17391/mcp
```

Three tools, all read-only:

- `frond_list_runtimes` — what is attached, and how much history the hub still holds for each. Start here; the others take an `attachmentId` from it.
- `frond_read_events` — events oldest first, filterable by tag, category, severity, and nodeId, paged with `since`.
- `frond_read_work` — every event belonging to one `workId`, which is one whole acquire/refresh/action cascade. The tool for "what actually happened when that failed".

Every reply carries a `coverage` block, because the honest answer to "did anything else happen?" is often "yes, and the hub no longer has it". `evictedByHub` counts what the ring dropped; `droppedBySender` counts what the app dropped before sending. `oldestRetainedSequence` above 1 means history is missing from the front — normally just because the hub subscribed after the runtime started, but also after a reconnect, where `generation` above 0 is the tell.

## Restarts

Nothing here is durable, deliberately. An app that loses the hub retries every two seconds forever and comes back as the same `instanceId` with `generation` bumped, but the events it emitted while disconnected are gone, and stopping the hub discards every retained ring. That is the intended shape of a tool you point at a process you are actively working on — if you need history that survives a restart, you need a sink, not a devtools hub.

## Security

Unauthenticated on both paths, deliberately and only for local development. The hub binds loopback and the attach socket carries data one way, so the worst an uninvited local caller does is put junk in a dashboard — but that junk then reaches an agent through MCP. Records are not proof of their own origin: a reader that treats a record's `tag` or `fields` as instructions rather than as data is trusting whatever managed to open a socket.

Do not point this at production data, and do not expose the port beyond loopback.

## Develop

```sh
bun --conditions=source test apps/hub/test
```

The hub is itself a Frond app — canonical nodes, an Ink UI built on `@frondruntime/react` — so it reports on itself with no special-casing. `isHubInternal` is the one exception: it drops records whose nodes are all `hub/`-prefixed, without which applying a batch would emit the events that make up the next batch.
