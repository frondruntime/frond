# @frondruntime/devtools

Client half of the Frond devtools hub. One call attaches a runtime to a local hub, which streams its events in and can ask it what the graph looks like right now — both readable by a coding agent over MCP.

## Install

```sh
bun add -d @frondruntime/devtools
```

A dev dependency, not a runtime one. The intended shape is a call that only exists in development builds — see [Guarding it](#guarding-it) below.

An ordinary dual-entry ESM library: `.` for the attach client and `./node` for filesystem discovery, both shipped built, installable with any package manager and runnable on Node, Bun, a browser bundle, or React Native. The Bun requirement belongs to the hub daemon, not to this half — see [The hub](#the-hub).

`@frondruntime/core` and `effect` are peers. There are no runtime dependencies.

## Attach

```ts
import { attachDevtools } from "@frondruntime/devtools";

const detach = attachDevtools({ runtime, name: "my-app" });
```

That is the whole configuration surface for the common case. With no `url`, it dials the hub's default address; with no `platform`, it guesses one from the environment. The returned function detaches.

Attaching never throws and never rejects. If no hub is listening it retries quietly every two seconds, so the call is safe to make before the hub starts, after it stops, and across restarts of either side. Pass `onError` if you want to see why it is not connecting.

"Forever" has one exception. A hub that *refuses* the attachment — today, only a protocol version mismatch — is answering a question about this build, and every retry would ask it again and get the same answer. So a refusal stops the loop and says so out loud, once, on the console. Supplying `onError` takes ownership of reporting it and silences that fallback. The alternative is what this used to do: redial every two seconds, silently, for the whole life of a process that was never going to attach.

## What gets sent

The event stream, and — when the hub asks — a snapshot of the graph as it stands, which is what backs the hub's `frond_read_state` tool. Both go through the same encoder, so a node that is failing in a snapshot and the event that failed it read identically.

Values in either are redacted by default. `attachDevtools` declares a **ceiling** and the hub asks for a policy; the lesser of the two wins, and the ceiling defaults to `"shape"`:

| Policy    | What a value looks like on the wire                                                        |
| --------- | ------------------------------------------------------------------------------------------ |
| `"none"`  | The literal `"withheld"`, in place of every value                                            |
| `"shape"` | A one-line descriptor: `{id,name,total}`, `Wired{_tag,run}`, `string[42]`, `Map(3)`           |
| `"full"`  | The value itself, bounded by depth, string length, entry count, and per-record value count    |

```ts
attachDevtools({ runtime, name: "my-app", values: "full" });
```

Opt into `"full"` per app, deliberately. The runtimes worth debugging are the ones holding tokens and account state, and a default that ships values is a default that ships them the first time someone forgets. The hub always asks for `"full"` — once for the event stream when the attachment is accepted, and again on every state read — so the ceiling is the only thing standing between a reader and the data. That is the intended arrangement rather than a gap in it: the decision to put real values on a socket belongs to the app that owns them, not to the tool reading them.

`"none"` is its own encoder rather than a stricter `"shape"`, because a key list is itself a description of app data — an app that said it would send none should not be sending the key names of every node in a graph snapshot.

At `"shape"` the descriptors are strings rather than JSON objects, because this feed is read by an agent through MCP and a node result rendered as forty lines of pretty-printed JSON that contain no data is worse than one rendered as `{id,name}`. Numbers, booleans, and strings up to 256 characters still cross verbatim: in a runtime event those are ids, tags, timestamps, and flags, which is the entire signal. Anything structured is a descriptor, because a node result or an action input is always an object or an array. A class instance gives up only its type — `AccountModel{?}` — and `_tag` is the one nested field that survives, since a failure feed that says `{_tag,nodeId}` instead of `GraphNodeAcquireFailed` is not worth reading.

Every bound at `"full"` announces itself in the output: `{"_": "elided", "by": "depth"}` — or `"budget"`, or `"entries"` — where the walk stopped, and a `{"_": "string"}` descriptor carrying `length` and `head` where a string was cut. A cap a reader cannot see is worse than a low one, because it turns "there was more" into "that was all". Markers stay objects under a `_` key at this policy, where the values around them are real data and a marker has to remain distinguishable from one.

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

### React Native

Nothing to install: this package uses no global beyond `WebSocket`, so there is no `crypto` polyfill to add and no Node shim to configure.

What does differ is the address. **The default is loopback, and loopback means something different on each target.**

| Target                     | What to do                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| iOS Simulator              | Nothing. It shares the host's network stack, so `ws://127.0.0.1:17391/attach` is the hub.     |
| Android emulator           | `adb reverse tcp:17391 tcp:17391` on the host, then the default URL works unchanged.          |
| Android emulator, no `adb` | Start the hub with `--host 0.0.0.0` and pass `url: "ws://10.0.2.2:17391/attach"`.             |
| Physical device            | Start the hub with `--host 0.0.0.0` and pass `url: "ws://<host-lan-ip>:17391/attach"`.        |

`adb reverse` is the better of the two Android options: it tunnels the port to the emulator over the existing debug bridge, so the hub stays on loopback and the app keeps the default URL. `10.0.2.2` is the emulator's alias for the host, and reaching it means the hub has to be listening on every interface.

**`--host 0.0.0.0` puts an unauthenticated socket on your local network.** The hub has no notion of who is on the other end, in either direction: anything that can reach the port can push records into the dashboard an agent then reads, and can ask attached apps for graph snapshots up to whatever ceiling they declared. On a trusted network, for a development build, that is the trade; do not leave it bound that way, and do not do it at all with an app whose ceiling is `"full"`.

### Testing

Attaching from a Jest suite reaches Effect's RPC layer, which pulls in `msgpackr` — an ESM-only package that Jest's default CJS transform cannot load, and one this package does not choose: it is a dependency of `effect` itself, so no serialization setting here avoids it. Either run the suite as ESM, or let Jest transform it:

```js
// jest.config.js
transformIgnorePatterns: ["node_modules/(?!(msgpackr|msgpackr-extract)/)"];
```

The narrower fix is not to attach in tests at all. `attachDevtools` exists to watch a process you are working on by hand; a test run has no hub to dial and nothing to watch.

Filesystem discovery lives behind its own export, so a browser bundler never has to resolve it:

```ts
import { readHubLock } from "@frondruntime/devtools/node";

const lock = readHubLock(); // undefined when no hub is running
```

`readHubLock` walks up from the working directory looking for `.frond/hub-<port>.json`, which a running hub writes and removes on exit. Useful for scripts that should do nothing when the hub is down.

## The hub

The other half is `@frondruntime/hub`, a local daemon that holds the event history, asks attached apps for graph snapshots, and serves both to a coding agent over MCP:

```sh
bunx @frondruntime/hub
```

That daemon ships as TypeScript source and renders with Ink, so it needs Bun — `npx` cannot run it. Nothing about that reaches this package: the attach client is built ESM and runs wherever the app does. See its [README](../../apps/hub/README.md).

The two halves must agree on `HUB_PROTOCOL_VERSION` exactly, with no capability negotiation, because a partial mismatch presents as "the runtime stopped emitting" rather than as an error. A hub that sees a version it does not recognize refuses the attachment in one line naming both numbers and which side is behind, and this side stops retrying and prints it.

## AI use

Frond is AI-assisted (mainly Claude and Codex), iterated over months rather than one-shot generated. Full note: https://frondruntime.dev/ai-use
