---
name: frond-debugging
description: Use when diagnosing Frond runtime behavior - nodes stuck pending, readiness errors, actions that never run or overlap, stale results, cleanup leaks, blank or looping React trees - and when observing a live app through the devtools hub and its MCP tools.
---

# Frond Debugging

A Frond symptom is a projection. Diagnose the node cell's transition and the
work that owns it — not the component that rendered the symptom. Collect
evidence in escalating order; stop at the first level that answers the
question.

## Evidence Order

1. **Typed handle read.** `runtime.client.node(Spec, args).read()` — the
   tagged phase answers most questions. Compare `nodeId` values; never parse
   them.
2. **Handle snapshot.** `handle.snapshot()` for the node's operations,
   attempts, and validity when the phase alone is not enough.
3. **Filtered runtime events.** Subscribe a capturing sink (tests: the
   harness `events`; live: the hub). Filter by node tag and category before
   reading anything.
4. **Whole-runtime snapshot.** `runtime.getSnapshot()` last, not first.
5. **Diagnostics projection.** `Frond.Diagnostics.projectError` on any
   captured error before reasoning about it; read cause chains structurally,
   never by message substring.
6. **Source.** The installed `@frondruntime/*` source is the authority over
   every document, including this one.

## Read Phase → Where To Look

| Phase | Meaning | First suspects |
|---|---|---|
| `Unwired` | nothing demanded the node | missing dependency edge, wrong args/key |
| `Idle` | known, not started | demand path never reached it; preheat missing |
| `Pending` | operation in flight | dependency not ready; acquire awaiting an unresolved external; deadlock via mutual deps |
| `Ready` | committed result | staleness: snapshot-at-acquire; missing refresh |
| `Error(kind)` | typed failure | readiness vs operation kind decides: acquire path vs action path |

Common mechanisms behind the big symptoms:

- **Stuck pending** — a leaf awaiting an external that never settles without
  an internal deadline; a dependency edge to a node nobody starts; an
  unbounded action admission queue behind a hung operation.
- **Duplicate node / wrong data** — two keys that should be one: non-canonical
  args, environment leaked into the key, `Key.structure` over unstable fields.
- **Action never runs** — caller holds a stale node from a previous
  incarnation; admission queued behind a hung operation; the promise was
  dropped and its rejection with it.
- **Stale result** — dependency state copied at acquire (see
  frond-graph-topology); a refresh nobody triggers.
- **Cleanup leak** — release read `ctx.node` mid-teardown instead of the
  result captured up front; unbounded teardown awaiting an attached peer;
  partial acquire that failed after building resources.
- **React blank / loop** — Suspense read without an ErrorBoundary; a
  non-`observer` component reading observable getters; an unstable `useNodes`
  key set re-suspending every render.

## Live Observation: The Hub

The hub is a local devtools daemon; apps attach to it and stream runtime
events, and agents read back over MCP.

- Run it: `frond-hub` (from `@frondruntime/hub`; Bun-only daemon, loopback
  only). It writes a lockfile at `.frond/hub-<port>.json` with the attach URL
  and pid; `readHubLock` from `@frondruntime/devtools/node` discovers it.
- Attach an app: `attachDevtools({ runtime, name })` from
  `@frondruntime/devtools` at the composition root.
- MCP tools: `frond_list_runtimes` (who is attached), `frond_read_events`
  (event history, filterable), `frond_read_work` (operations in flight),
  `frond_read_state` (current graph state).
- Connect an agent to the hub's MCP endpoint (HTTP transport, same port,
  `/mcp` path). Project `.mcp.json`:

  ```json
  {
    "mcpServers": {
      "frond": { "type": "http", "url": "http://127.0.0.1:17391/mcp" }
    }
  }
  ```

  or `claude mcp add --transport http frond http://127.0.0.1:17391/mcp`.
  If the hub runs on a non-default port, read it from `.frond/hub-<port>.json`.
- Value policy is `none < shape < full`, enforced by the **sender**. The hub
  asks; apps clamp. If values arrive as shapes, raise the app's ceiling —
  do not look for a hub-side switch.
- Devtools silently not connecting is what a protocol version mismatch looks
  like; the rejection line names which side to upgrade. Check hub and app
  `@frondruntime/*` versions first.

Start MCP reads with `frond_read_state` scoped to the suspect node's tag,
then pull `frond_read_events` for that node across the failure window.
Unfiltered full-history reads are the whole-runtime snapshot mistake again.

## Report Format

Findings from any debugging session are reported as:

- **Observation** — evidence collected, with phases/events quoted.
- **Inference** — the mechanism, named in cell/work terms.
- **Fix** — the smallest change at the owning layer.
- **Validation** — the read/event/test that proves it.
- **Unknown** — what the evidence does not establish.

No fix ships on inference alone; validation is part of the diagnosis.

## Avoid

- Starting from `runtime.getSnapshot()` or unfiltered event dumps.
- Parsing `nodeId` strings or error message text.
- "Fixing" symptoms in React (retry loops, key remounts, effect flags) when
  the mechanism is a cell transition.
- Sprinkling `console.log` into drivers — use events and sinks; they carry
  node identity and ordering.
- Concluding from one read what a `waitForNodeRead` predicate should prove.

---

Describes: @frondruntime/core 0.4 (checked against .release-please-manifest.json by `bun run skills:check`)
