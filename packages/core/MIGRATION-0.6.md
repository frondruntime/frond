# Migrating from 0.5 to 0.6

> 0.7 replaces §1 and §2 below: results are frozen and `node.result` is the
> committed snapshot, shared between commits. See [MIGRATION-0.7.md](./MIGRATION-0.7.md).

0.6 keeps the 0.5 public API: `createRuntime`, MobX nodes, `Driver.*`, the
Effect client, and `@frondruntime/react`. Inside, a synchronous job queue
replaces the per-node Effect actors, so actions, reads, and boot run faster
and allocate less, on Hermes in particular. Node authoring, specs, and imports
are unchanged.

What an app can observe changes in the places below. Each one is pinned by a
test marked `0.6 intended change`.

## Behavior changes

### 1. MobX node results are read-only

0.5 deep-copied each result into MobX observables on every sync. 0.6 stores
the object the driver returned, as an `observable.ref`. Code that changes a
result in place, such as `node.result.items.push(item)`, no longer notifies
any reaction, `observer` component, or React reader, and it changes the
driver's own object.

Treat `node.result` as read-only. To change it, run a `patchResult` action,
refresh the node, or return a new value from the driver.

### 2. React result readers skip status-only renders

`useNode` and `useNodes` re-render only when the read's `_tag`, the node
instance, its `result`, `deps` or `args` reference, or the read error
changes. Starting an operation, `busy`, and validity changes no longer
re-render them. A component that shows a spinner or an operation failure
reads them with `useNodeState`, which re-renders on every change as before.

### 3. An equal refresh keeps the old result

When a refresh, or a re-acquire after expiry, returns data deeply equal to
the current result, the node keeps the current reference. No MobX change and
no React render follow. Equality covers plain data only: primitives
(`Object.is`), arrays, and plain objects. Class instances, `Date`, and `Map`
compare by reference, so they are always replaced.

### 4. An aborted call rejects with an interruption `Cause`

Aborting `metadata.signal` on `ensureReady`, `ensureReadyNode`, `boot`, an
action, `refresh`, or `updateArgs` rejects the call with an interrupt-only
Effect `Cause`. 0.5 already did this for actions, but rejected an aborted
`ensureReady` with the `Error` "All fibers interrupted without error", and
ignored the signal on `refresh`. An aborted `refresh` or `updateArgs` caller
now settles at once; the refresh itself keeps running and commits.

```ts
import { Cause } from "effect";

const isAbort = (error: unknown) =>
  Cause.isCause(error) && Cause.hasInterruptsOnly(error);
```

Replace any check on the message "All fibers interrupted without error" with
this one.

### 5. Order of one commit

A commit now runs in a fixed order: the graph commits, MobX nodes are written,
event listeners run, then the caller's promise settles. A success listener or
a MobX reaction therefore reads the MobX node already updated; in 0.5 it could
read the previous value.

### 6. No command spans on the Promise facade

`createRuntime` and `node.runAction()` no longer open
`frond.runtime.command.*` spans. The Effect client keeps them, and driver
edges keep their spans for callers on the Effect client.

### 7. A repeat call after a cancelled caller runs fresh

If the only caller of an action or refresh is aborted, an identical call made
right after starts a new operation. In 0.5 it could join the abandoned one and
receive its value.

### 8. `dependencies(args)` must be a pure function of args

Re-planning a node that is already wired with the same key (every `ensure`,
`ensureReady`, or `ensureReadyNode` of an existing node, including the
readiness call each React node store makes) returns the wired node without
calling `dependencies()` again or re-planning its dependency closure. Before, every such call re-ran both.

What breaks: a `dependencies()` that reads anything other than its args, such
as the time, a global, or a mutable closure, no longer changes a wired node's
dependencies. The same holds for a custom `key` that leaves out an argument
the dependencies depend on. A same-key re-plan whose dependencies would
differ, or whose `dependencies()` would now throw or return a malformed
record, may keep the wired node unnoticed, or may be marked `Invalid` on a
later full re-plan, which runs, for example, after any eviction in the graph,
not only one of this node. Which one you see depends on unrelated graph
activity, so do not rely on either.

The development check narrows this. It runs where `process.env.NODE_ENV` is
not `"production"` at runtime (a React Native `__DEV__` build, Node or Bun in
development or test) and is off when `process` is absent (a browser bundle
without a `process` shim). Where it runs, a same-key re-plan calls the
requested node's `dependencies()`, validates the result as a full plan does,
and marks the node `Invalid` on a mismatch or a malformed record. The
requested node's dependencies are re-checked; internal dependencies are not.

### 9. A React reader that mounts with other args moves a ready node to them

A singleton, or a keyed node whose `key(args)` leaves out some args, can be
Ready with args other than the ones a reader asks for, for example after
`ensureReady` with `{ page: 1 }`. In 0.5, a `useNode`, `useNodeState`,
`useNodeRead` or `useNodes` reader that then mounted with `{ page: 2 }` kept
the node on `{ page: 1 }` and showed its result. Now the reader's first mount
compares its args with the node's stored args and, when they differ, updates
the node to its own args, as a change of a mounted reader's args already did.
Equal args update nothing.

The last mount wins. A reader already mounted with `{ page: 1 }` shows
`{ page: 2 }` once a second reader mounts with it, and does not push its own
args back until its own args change or it mounts again. Readers that mount in
the same commit are ordered by React's effect order: of two siblings the later
one wins, and a parent wins over its child, whose effects run first. A mount
compares its args with those of an update another React reader queued for the
node and has not yet settled, else with the stored args, so readers mounting
together with the same args update the node once. An update made outside
React, such as `handle.updateArgs`, is not tracked: a mount while one is in
flight compares with the stored args.

In `useNodes`, only an entry that is new or whose own args changed aligns its
node. An unchanged entry submits only to retry its own change that failed,
when another entry of the same `useNodes` call changes its args under the same
key and the node does not hold the entry's args. A key change of another entry
rebuilds every entry's store and drops that retry. Readers that need
independent results at the same time should use distinct keys: put every arg
the result depends on into `key(args)`.

A `useNodeRead` reader that mounts while the node is still Pending under other
args, with no React update queued for it, does not compare them, since a
Pending node has no stored args to read.

### 10. Graph work runs after the caller's synchronous frame

A call to the graph (an action, `refresh`, `ensureReady`, a React read) is
posted to one queue that drains in a microtask. In 0.5, a synchronous driver
ran inside the call. Code that reads state in the same synchronous frame as
the call sees what was there before it.

- A call returns before its driver runs. A read in the same frame still has
  the old result; await the call first.

  ```ts
  const saving = node.actions.save("unsaved");
  node.result.draft; // 0.5: "unsaved", 0.6: ""
  await saving; // now "unsaved"
  ```

- An abort in the same tick as the call cancels the call before its driver
  runs, so the driver never runs. In 0.5 the driver ran once and then saw the
  abort.
- An abort of a running call reaches the driver's `ctx.signal` once the queue
  drains, before the caller's rejection settles. In 0.5 `ctx.signal` was
  aborted inside `controller.abort()`.
- A node that is not Ready suspends on its first React read, also when a
  `readySpec` override supplies its result. A synchronous
  `act(() => render(...))` commits only the Suspense fallback.
- The MobX write of an action lands after a synchronous `act` returns.
- Nodes that start together on one dependency that is not Ready yet start in
  no promised order. In 0.5 the node that started the dependency ran first;
  in 0.6 the nodes that joined it can run first. Assert on results, not on
  the order the drivers ran.

In tests, mount and call inside an async `act`, or wait for the harness:

```tsx
await act(async () => {
  render(<TestFrondProvider harness={harness}>{tree}</TestFrondProvider>);
});
await act(async () => {
  await node.actions.save("draft");
});
// or, inside an async act: await harness.waitForIdle();
```

To assert the loading state, hold the driver with `createDeferred` and
resolve it inside a later `act`.

Suspense can now appear where 0.5 rendered synchronously. A layout effect
that lifts state into a parent and clears it in its cleanup can loop with
"Maximum update depth exceeded" when a sibling in the same Suspense boundary
suspends. Wrap the suspending branch in its own Suspense boundary.

## Fixes worth knowing

- A late reply from an older `updateArgs` call no longer moves `handle.args`
  back to older args.
- An action aborted while an event sink is still running no longer leaves the
  node `busy` with a `Running` operation.
- `@frondruntime/devtools` keeps the readable part of a value it cannot read
  whole. At `"full"`, a key named `__proto__`, as `JSON.parse` makes one,
  crosses as an own field instead of failing the batch. An array entry or
  `length`, a collection's `size` or iterator step, a function's `name`, a
  failure payload's field, an event's field, or a signal event's `channel` or
  `name` whose read throws costs only that entry or field; an array whose
  `length` throws is as long as its index keys say, and a `channel` or `name`
  that is not a string is left off. At `"shape"`, an array's first element and
  its length, and an object's `_tag` and its keys, are read apart, so one
  throwing costs only its part of the label. A collection whose iterator throws
  partway keeps the entries read before it, and one longer than 4,096 entries
  stops there and ends in a cut marker, as an array does. A failure `path` with
  holes crosses with `"undefined"` in each hole instead of failing the batch.
  A `Date` whose `toISOString` returns something other than a string crosses
  as unreadable instead of failing the batch. One case still costs the whole
  object: a proxy whose `getOwnPropertyDescriptor` trap throws for one key
  crosses as unreadable, because listing its keys is the read that throws.
- Once `RuntimeStop` has interrupted the running event sinks, no sink starts
  except for the stop's own events. An event that work the stop interrupted
  emits while the stop closes, such as `GraphSystemStarted` or
  `GraphNodeReadinessFailed`, still reaches every synchronous listener but no
  sink; a listener that throws on one records no
  `RuntimeObserverFailureObserved`. This holds for a signal publication too,
  which the stop does not interrupt: once `RuntimeStop` resolves, a delivery
  parked on a sink still reaches its listeners but starts no sink. An input
  whose sink the stop interrupted now settles instead of hanging, and a MobX
  projection that fails after the stop records nothing after `RuntimeStopped`.
- When two args updates from one React reader both fail, the reader no longer
  treats the first request's args as current. A later change to those args now
  submits them instead of doing nothing.
- After a React reader's args update fails, the reader compares its next args
  with the node's. It no longer treats the args of an earlier request that
  failed too, or of another update running when the failure arrived, as
  current, so a later change to those args submits them instead of doing
  nothing. A match with an args update still running counts once that update
  succeeds, also when the reader's next call comes after another update moved
  the node on or after `<Activity>` hid the reader; if it fails, including
  when an eviction cancels it, the reader's next call compares again. One
  exception: a reader hidden while its matched update from outside React
  fails, whose failure record a later operation replaced before the reveal,
  or whose node was evicted and acquired again, counts that update as
  succeeded and does not retry its unchanged args. When a reader's earlier
  request fails after it submitted a later one, the reader keeps the later
  one as current, so an unchanged `useNodes` entry does not push its args
  back over an update made since.
- A React reader hidden by `<Activity>` whose args change while hidden
  submits its new args when it is revealed. Before, the reveal dropped them
  and the node kept the args from before the hide.
- Teardown runs dependents first. When an eviction or a runtime stop tears
  down several nodes, a node's `release` hook and disposers finish before any
  node it depends on starts its own cleanup, so a dependent's cleanup can
  still use its dependencies (an unsubscribe over a transport node, for
  example). In 0.5, eviction cleaned up dependencies first and stop ran every
  cleanup at once, so such a disposer could see a closed dependency and the
  eviction returned a `DisposerFailed`. What you may observe: hooks and
  disposers of different nodes run in the new order; stop still interrupts
  all running work at once, then cleans up each node as soon as all of its
  dependents have finished, every node otherwise concurrently, and each node
  waits for its own interrupted work to finish only when its cleanup comes
  up, and for at most `driverTimeouts.release`; a slow dependent's cleanup
  delays its dependencies' and no other node's; eviction still cleans up
  one node at a time; an interrupted eviction leaves dependencies in place
  rather than dependents. The `nodeIds` an eviction returns, its
  `failures`, and the results of stop keep their order. Two consequences to
  check in your app:
  - Cleanup deadlines add up. `driverTimeouts.release` bounds each step on
    its own, not a node's cleanup as a whole: the `release` hook, then each
    disposer in turn, each get the full timeout, so one node with two
    hanging disposers takes about two release timeouts. During a stop or an
    eviction, the wait for a node's interrupted work to finish is one more
    step with the same bound; when it runs out, the node's cleanup starts
    while that work keeps finishing, and the stop or eviction returns only
    after the interrupted work of every node it tore down has finished, so
    work that never finishes still keeps it from returning, as in 0.5. A
    wait that runs out reports no failure: no stop or eviction result and
    no `GraphNodeCleanupFailed` event names it. Once a wait has run out,
    canceling the eviction no longer ends it early: it still cleans up the
    remaining nodes and waits for that work, and only then settles as
    interrupted. A node starts its cleanup
    only when its dependents end, so these deadlines add up along a
    dependency chain: a chain of three nodes whose disposers all hang takes
    about three release timeouts to stop, where 0.5 took about one. Nodes
    on separate chains still run side by side during stop. There is no
    stop-wide or eviction-wide timeout.
  - A dependent's cleanup must not wait for its dependency's cleanup. The
    dependency's cleanup starts only after the dependent's ends, so a
    dependent's disposer that waits for its dependency's disposer now waits
    until the release timeout and reports a `DisposerFailed`; in 0.5 it
    completed. The same holds for the finalizer of a dependent's action
    that a stop or an eviction interrupts: if it waits for its dependency's
    teardown, the stop or eviction now holds that dependency back for one
    release timeout, then cleans up the dependent while the finalizer still
    waits, and the finalizer finishes once the dependency is torn down. In
    0.5 the dependency was torn down without that wait.

## Same as 0.5, easy to hit while migrating

- An action still running when its node is evicted or the runtime stops
  rejects. A node handle's action rejects with `ActionFailed` whose cause is
  `NodeEvicted`, and a runtime-client handle's action resolves to a `Failure`
  outcome with that error. When the runtime stops, `NodeEvicted` carries the
  `RuntimeStopped` cancellation. A test that starts an action without
  `await` and tears down before it ends must catch that rejection, or the test
  runner reports it as unhandled. `harness.waitForIdle()` waits for such an
  action before it returns.
- A live resource without an `update` hook restarts whenever its demand
  changes, and adding a lease source changes it: a `"manual"` lease followed by
  a `"mobx"` lease on the same node runs `stop` with reason `DemandChanged`,
  then `start` again with both sources. A resource whose `start` has a side
  effect, such as an import, runs it twice. Give it an `update` hook, which
  receives the new demand and keeps the running resource; an empty one is
  enough when the resource does not depend on its sources.

  ```ts
  live: Driver.Live({
    start: (ctx, demand) => startImport(),
    update: () => {}, // a new lease source keeps the running import
    stop: (ctx, resource) => resource.close(),
  }),
  ```
