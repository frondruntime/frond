# @frondruntime/devtools

Client half of the Frond devtools hub. One call attaches a runtime's event stream to a local hub, where a coding agent can read it over MCP.

## Install

```sh
bun add -d @frondruntime/devtools
```

A dev dependency, not a runtime one. The intended shape is a call that only exists in development builds — see [Guarding it](#guarding-it) below.

`@frondruntime/core` and `effect` are peers. There are no runtime dependencies.

## Attach

```ts
import { attachDevtools } from "@frondruntime/devtools";

const detach = attachDevtools({ runtime, name: "my-app" });
```

That is the whole configuration surface for the common case. With no `url`, it dials the hub's default address; with no `platform`, it guesses one from the environment. The returned function detaches.

Attaching never throws and never rejects. If no hub is listening it retries quietly every two seconds, so the call is safe to make before the hub starts, after it stops, and across restarts of either side. Pass `onError` if you want to see why it is not connecting.

## What gets sent

Values are redacted by default. `attachDevtools` declares a **ceiling** and the hub asks for a policy; the lesser of the two wins, and the ceiling defaults to `"shape"`:

| Policy    | What a value looks like on the wire            |
| --------- | ---------------------------------------------- |
| `"none"`  | Nothing but the field's presence               |
| `"shape"` | Type, key names, lengths — no contents         |
| `"full"`  | Contents, bounded by depth, size, and count    |

```ts
attachDevtools({ runtime, name: "my-app", values: "full" });
```

Opt into `"full"` per app, deliberately. The runtimes worth debugging are the ones holding tokens and account state, and a default that ships values is a default that ships them the first time someone forgets.

### Failures

Failures are not values, and the policy table above only half applies to them. A failure crosses as its **chain of causes**, outermost first, because the outermost link is rarely the one worth reading — Frond wraps failures as it unwinds, and a `RefreshFailed` around an `AcquireFailed` around the thing your driver actually threw has an empty message of its own.

```json
{
  "_": "error",
  "message": "upstream orders unavailable in eu-west (503)",
  "causes": [
    { "index": 0, "tag": "AcquireFailed", "nodeId": "feed:v1:…", "nodeTag": "feed" },
    { "index": 1, "tag": "DriverPromiseFailed", "operation": "acquire" },
    { "index": 2, "name": "Error", "message": "upstream orders unavailable in eu-west (503)" }
  ]
}
```

`message` is the deepest one that says anything — a hoisted field, not a summary. Each frame carries what the failure named: `tag`, `nodeId`, `operation`, `dependency`, `path`.

Messages cross at every policy including `"none"`, on the grounds that an app that has turned values off still wants to know what is failing. Two things are `"full"`-only: each frame's `stack`, and `fields` — the error's own payload, the `status` and `endpoint` and request id that a chain cannot name in advance.

To drop records entirely rather than redact them, filter:

```ts
attachDevtools({
  runtime,
  name: "my-app",
  include: (record) => !record.nodeIds.some((id) => id.startsWith("auth/")),
});
```

## Guarding it

```ts
if (import.meta.env.DEV) {
  attachDevtools({ runtime, name: "my-app" });
}
```

The attach socket is unauthenticated by design — it only carries data *into* the hub, so an uninvited caller achieves nothing worse than junk in a dashboard. But the hub it dials is a plain loopback port with no notion of who is on the other end, so shipping a call to it in a production build points real user state at whatever answers. Guard it.

## Platforms

The main entry imports nothing from `node:`. The transport is a global `WebSocket` carrying ndjson, so the same build attaches from a browser, from Bun, from Node, and from React Native.

Filesystem discovery lives behind its own export, so a browser bundler never has to resolve it:

```ts
import { readHubLock } from "@frondruntime/devtools/node";

const lock = readHubLock(); // undefined when no hub is running
```

`readHubLock` walks up from the working directory looking for `.frond/hub-<port>.json`, which a running hub writes and removes on exit. Useful for scripts that should do nothing when the hub is down.

## The hub

The other half is `frond-hub`, a local daemon that holds the event history and serves it over MCP. It is not published yet; it lives in this repository under `apps/hub`.

## AI use

Frond is AI-assisted (mainly Claude and Codex), iterated over months rather than one-shot generated. Full note: https://frondruntime.dev/ai-use
