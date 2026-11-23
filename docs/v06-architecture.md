# Frond 0.6: a synchronous core, a MobX face, Effect at the edges

Status: accepted by the owner on 2026-11-19. This is the build spec for the 0.6
rewrite.

## Goal

0.6 is 0.5 made faster and lighter **on Hermes**. Allocation per action
matters more than bundle size. 0.5 is the shape: its public API stays
source-compatible and its behavior is what the tests pin.

## Fixed

- The public 0.5 API stays source-compatible: `createRuntime`, the class node,
  the react package, `Driver.*`, the Effect client.
- 0.5 semantics (demand, lifecycle, validity, admission) are what the tests
  pin. The 1.0 kernel is **not** copied in; there is no pure
  `step(cell, intent)` kernel. 0.6 de-Effects 0.5's own graph.
- `Effect.Match` is gone from runtime code and must not come back.

## Owner decisions

1. **State ownership.** A plain closure (the cell store) owns node state.
   MobX's eight `observable.ref` fields mirror it: written synchronously,
   once per queue run, only for nodes that changed. A result is the object the
   driver returned, not a deep observable copy, and it is read-only: changing
   it in place notifies nothing. A new result comes from a commit (a
   `patchResult` action, a refresh, an acquire). There is no development-mode
   freeze and no projected copy (2026-11-19). Superseded in 0.7: committed
   results are frozen and `node.result` is the committed snapshot behind
   one observable reference, shared between commits
   (packages/core/MIGRATION-0.7.md).
2. **Spans.** Spans exist only on the Effect facade and on driver edges. The
   Promise facade (`createRuntime`, `node.runAction()`) opens no command spans.
   `packages/core/test/runtime-events.test.ts` (tracer supplied with
   `Effect.withTracer`) must keep passing.
3. **Clock.** The core reads time only from the runtime's `syncClock`. Effect
   `Clock` stays only inside Effect driver bodies and timeouts.
4. **Drain.** One job queue per runtime, drained on a microtask until empty.
   Not an Effect fiber, not a synchronous drain on the caller's stack.
5. **Keep:** eight MobX fields (no atoms unless measured), no separate Effect
   entry point, async-driver timeouts on Effect.
6. **Abort rejection.** A Promise call aborted through `metadata.signal`
   (`ensureReady`, `ensureReadyNode`, `boot`, an action, `refresh`,
   `updateArgs`) rejects with its interrupt-only Effect `Cause` on every path,
   as an aborted action already did in 0.5. Not a squashed `Error`, not
   `signal.reason` (2026-11-19).

## Layers

| Layer | Owns | Replaces |
|---|---|---|
| Cell store | Node state, plain closure, mutable counters | `Effect.sync` wrappers in `cellState.ts`, state spreads per transition |
| Graph gate + job queue | Node map, admission maps, job queue, "exclusive in flight" flag for evict/stop | `cellActor.ts`, `cellSubmission.ts`, `admissionRegistration.ts`, both `Semaphore`s, `Deferred`, `Ref`, `Scope` per actor |
| Per-cell queue | `active` operation + FIFO `pending` | cell `Semaphore` |
| `startEdge` | Driver runs: sync return settles inline, promise via `then`, Effect driver via one `runFork` | per-run `Effect.try` / timeout / span / `catchCause` wrappers |
| Event bus | Listeners indexed by node; no event record built when nobody listens | `Effect.forEach` + generator emits |
| Facades | Promise facade calls the core directly; Effect facade wraps it via `Effect.callback` | `runPromise` + `gen` per call |
| MobX face | 8 ref fields, one `runInAction` per queue run, dirty nodes only | async `sync()` and ~5 snapshot round trips per action |

## Ordering rules

- Hooks, listeners and MobX reactions never run the core on the caller's
  stack: they post a job.
- `settle` always posts. A late settle is refused by operation or attempt id
  (`nextOperationId`, `nextAttemptId` already exist).
- One operation owns a cell at a time, FIFO per cell. `close`/`shutdown`
  fail every pending entry with its interrupt reason.
- Eviction and stop hold the gate exclusively across their async release
  work; submissions arriving meanwhile wait, then plan a fresh cell.
- `onComplete` (admission cleared) runs before awaiters resume, so a
  waiter's follow-up call never joins the finished operation.
- A join operation clears its admission early, before its settle job
  drains, once its outcome is decided (the driver edge ended or the worker
  resumed) and no caller is attached: at the decision, or when the last
  attached caller detaches after it. A call after a cancelled only caller
  therefore runs fresh; while any caller is attached, plans that drain after
  the decision still join until `onComplete`.
- Order of one action: commit → MobX write → listeners → caller's promise.
  MobX fields are fresh when `await node.runAction()` returns.
- **Booting is visible at once.** Posting a readiness request marks the node
  as booting synchronously, so a read in the same render sees it and joins
  the in-flight attempt. Listeners are notified only when the queue runs (no
  render-phase update). The dirty `inFlightBoots` map in
  `runtime/client.ts` goes away once this holds. Evidence: the YouHodler
  unlock sent 74 boot submissions for 27 nodes.

## React store and result identity (amendment, 2026-11-19)

Evidence from the YouHodler unlock: every handle notification bumps the React
store version (`packages/react/src/nodeStore.ts` `sync()` -> `emit()`), so
each `auth/me` operation start re-rendered about 230 readers, and its settle
re-rendered them again.

- **Result readers emit on result changes only.** `useNode` and `useNodes`
  return only the node instance (`args`, `deps`, `result`). Their store emits
  only when the read's `_tag`, the node instance, its `result`, `deps` or
  `args` reference, or the read error changes. Status-only notifications
  (operation start, busy, validity) do not re-render them.
- **Status readers opt in with `useNodeState`**, which already returns
  `operation`, `busy`, `operationFailure` and `resultValidity`; it keeps
  emitting on every notification. No new public API.
- **An equal refresh keeps the old result.** When a refresh (or a
  re-acquire of a ready node) produces a result deeply equal to the current
  one, the commit keeps the current reference. Equality covers plain data
  only: primitives (`Object.is`), arrays, and plain objects compared by a key
  loop; anything else (class instances, `Date`, `Map`) compares by reference.
  `patchResult` actions are untouched. Subtree sharing (keeping references
  of unchanged branches) is not in 0.6.

## Where Effect stays (closed list)

Effect-mode driver bodies; timeouts and interruption; spans on the Effect
facade and driver edges; Effect sinks; the public Effect API via
`Effect.callback`. Nothing else. No `Effect.gen`, `flatMap`, `Ref`,
`Deferred`, `Semaphore`, `Fiber` or `Clock` on synchronous paths.

## Hermes rules for hot paths

Measured floors on Hermes: plain call 0.01 µs; `runSync` of a trivial gen
~5 µs; `runFork` ~2.6 µs; awaiting `runPromise` ~4 µs; a MobX box write with
an autorun ~8.6 µs; a `runInAction` writing 8 ref fields ~10 µs.

- No closures or arrays allocated per call where a shared constant works.
- No object spread to update state; mutate the cell's own fields.
- `switch` on `_tag`, never a matcher.
- Clone plain data with a key loop, never property descriptors.

## Migration order

Each step is a commit with all tests green (`bun run test`, `bun run
typecheck`, `bunx biome check packages`).

1. MobX face reads synchronously and coalesces syncs.
2. Event bus, observers and host observers become plain functions.
3. Hermes checkpoint (allocation + time).
4. Cell state, transitions, readiness, operation begin/complete/commit
   become plain functions.
5. Job queue, per-cell queue and gate replace the actor and semaphores;
   booting becomes visible at once.
6. `startEdge`.
7. Promise facade calls the core directly; `syncClock` everywhere.
8. React result readers emit on result changes; an equal refresh keeps the
   old result (see "React store and result identity").
9. Atoms, only if measured. 10. Error trimming, last.

## Tests

- Tests that use only the public entry (`packages/core/src/index.ts`,
  `@frondruntime/*`) are the contract: change them only with a recorded
  reason that the behavior change is timing-only.
- Tests that import an internal being replaced (for example
  `test/graph-cell-actor.test.ts`, `test/admission-registration.test.ts`)
  may be rewritten against the new internal or deleted when the internal is
  gone. Say so in the commit body.
