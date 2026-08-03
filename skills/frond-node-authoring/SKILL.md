---
name: frond-node-authoring
description: Use when creating, migrating, or reviewing Frond nodes with @frondruntime/core, including NodeSpec carriers, NodeBase classes, spec factories, driver hooks, dependencies, actions, cancellation, and lifecycle. Defines the one golden path and the only sanctioned deviations.
---

# Frond Node Authoring

There is one golden path. Deviations are enumerated in this file; anything not
enumerated is wrong. When the installed `@frondruntime/*` source disagrees with
this file or any other prose, the installed source wins — never reconstruct an
API from memory or from older call sites.

## Golden Path

Author the type carrier first, then the class, then the static descriptor:

```ts
import * as Frond from "@frondruntime/core";

type OrdersSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly deps: {
    readonly transport: Frond.Dep<typeof TransportNode>;
  };
  readonly result: OrdersState; // { readonly byId: Record<string, Order> }
  readonly actions: {
    readonly placeOrder: Frond.ActionContract<OrderInput, Order>;
  };
}>;

export class OrdersNode extends Frond.NodeBase<OrdersSpec> {
  static readonly spec = Frond.resourceSpec.async<OrdersSpec>({
    tag: Frond.tag("app/orders"),
    key: () => Frond.Key.singleton(),
    dependencies: Frond.dependencies(() => ({
      transport: Frond.dep(TransportNode, Frond.Args.none),
    })),
    acquire: Frond.Driver.Acquire(async (ctx) => {
      const orders = await ctx.deps.transport.client.orders.list(ctx.signal);
      return { byId: indexById(orders) };
    }),
    actions: {
      placeOrder: Frond.Driver.Action(async (ctx, input) => {
        const order = await ctx.deps.transport.client.orders.place(input, ctx.signal);
        ctx.patchResult((state) => {
          state.byId[order.id] = order;
        });
        return order;
      }),
    },
  });

  get rows(): ReadonlyArray<Order> {
    return Object.values(this.result.byId);
  }
}
```

- `type XSpec = Frond.NodeSpec<{ ... }>` is the single upfront carrier;
  `readonly mode` is its first member.
- Extend `Frond.NodeBase<XSpec>` directly. No intermediate base classes.
- The descriptor lives on `static readonly spec = Frond.resourceSpec.async<XSpec>(...)`
  (or `.effect`); same for `serviceSpec`, `nodeSpec`, `facadeSpec`. The factory
  flavor must match the shape-declared mode.
- `Frond.Key.singleton()` / `Frond.Key.structure(...)` only. Args stay canonical
  JSON-shaped `KeyInput`; the runtime rejects functions, `Date`s, and class
  instances.
- Wrap every driver channel: `Frond.Driver.Acquire`, `Refresh`, `Release`,
  `Live`, `Action`.
- Action return values are caller-facing output only. Result changes go
  exclusively through `ctx.setResult`, `ctx.patchResult`,
  `ctx.setResultValidity`.
- `ctx.patchResult((current) => { ... })` clones plain objects/arrays before
  running the recipe. A non-plain (class-instance) result requires the
  spec-level `resultPatch.nonPlainClone` opt-in; without it, patching fails
  with a typed error. Prefer plain result shapes plus class getters.
- Prefer inferred action `input` and driver `ctx` types inside the factory
  input. Annotate only when TypeScript cannot infer.
- Consumers call `node.actions.*`. Class methods exist only when they add real
  domain semantics — never as pass-through wrappers.

## Pick The Factory By Intent

Kind is descriptor metadata for humans and diagnostics — all four behave
identically at runtime. Pick for legibility:

| Factory | Use for |
|---|---|
| `serviceSpec` | singleton or keyed clients, transports, durable capabilities |
| `resourceSpec` | a ready result that owns cleanup: subscriptions, caches, handles |
| `facadeSpec` | a domain-facing API over dependencies (fan-out, coordination) |
| `nodeSpec` | the fallback when no specific kind fits |

Do not invent product-layer taxonomies on top of these, and never encode kind
into separate base classes.

## Sealed Or Leaf — Declare Which

Every node is exactly one of these two. There is no third kind and no hybrid.

**Sealed node (the default).** Every input arrives through `ctx.deps` or
`ctx.args`. No ambient globals, no vendor SDKs, no network, no storage, no
platform APIs. The driver body is orchestration over dependencies and pure
logic. A sealed node is testable by stubbing its dependencies and nothing else.

**Leaf node (the declared exception).** Owns exactly one outside capability —
a server socket, a storage API, one vendor SDK, one ambient global family.
Rules:

- One capability per leaf node. A second capability means a second node.
- The capability is acquired in `acquire` and torn down in `release`. Its
  lifetime handle (scope, disposer, client) lives **on the result**, not in
  module state, so `release` can read the result and nothing else.
- `release` reads the result once, up front; runs uninterruptibly; bounds its
  own teardown and prefers leaking a resource over hanging the runtime.
- A partial `acquire` failure cleans up everything it already built before
  rethrowing. A node that never reached ready must not hold a port, file, or
  subscription.
- Optionally the raw touch lives in a separate plain-TS leaf module (no Frond,
  no React imports; returns closed, frozen values) with exactly this node as
  its only importer. Prefer this when the ambient read is shared-shaped or
  security-relevant. Enforce the one-importer rule mechanically — a boundary
  check script or lint rule with a per-file allowlist, not a directory-wide
  exception.
- A leaf module opens with a short header comment naming its capability, what
  it exposes, and its fail-safe behavior. The "why is this safe" argument
  travels with the code.
- A leaf holding secrets wipes them on every exit path: a per-use wipe
  (`finally` / `Effect.ensuring` around the single use site) plus a
  per-lifetime wipe of any handle held across actions (release / runtime
  close).
- If a node is "mostly sealed but reads one global", it is a leaf. Review it
  as one.

## Mode: Async By Default, Effect By Confirmation

- Declare `mode: "async"` unless the driver genuinely owns concurrency
  structure: a scope with supervised children, streams/queues, merged
  listeners, a server, a vendor SDK with an unpredictable failure surface that
  needs typed containment.
- "React drives it" means async. "It supervises things" means effect.
- Do not choose effect mode unilaterally. Propose it with the one-line reason
  and get explicit user confirmation before authoring an effect-mode node.
  Record the confirmation as a comment directly above the spec —
  `// effect-mode: <reason> — confirmed <who/when>` — so review can verify it
  mechanically.
- Cross modes with `Frond.wrapPromise` / `Frond.unwrapEffect`; never by adding
  a second call channel.

## Results Hold State; Actions Do Work

- The result is domain state or a narrow capability. It is never a bag of
  functions that re-wraps dependencies.
- One sanctioned capability exception: a service node that owns an external
  client (transport, connection) may expose that client on its result, and
  dependents call it through `ctx.deps.x.client...`. Stateless request
  primitives belong there; domain workflows do not.
- If a result method takes an `AbortSignal` from the caller, the action lane
  has been rebuilt by hand. Move the work into an action.
- Result unions carry only ready facts. No `"unknown"` or `"loading"`
  members: a probe that cannot determine the fact fails the hook; the
  runtime already models pending.
- Multi-step flow encoding: a **linear** flow (start → verify → done) puts
  the step union in the result. A **cyclical** flow (quote → re-quote →
  submit) keeps a flat result plus a private node-owned machine, projected
  through a closed presentation getter. Pick one per node; do not mix.
- Commit-then-reveal: a result never claims `complete` until every side
  effect it implies has been awaited to completion. Await the handoff, then
  `ctx.setResult` — never concurrently.
- A stateful capability result still commits: every externally observable
  transition goes through `ctx.setResult` / `ctx.patchResult`, or the node
  is explicitly documented action-only/non-reactive. A capability that
  mutates itself silently is a stale-UI trap for the first reactive consumer.
- Mutable internals consumers must not touch ride the result envelope:
  `Frond.withInternal(publicResult, internals)` on commit,
  `Frond.internalOf(result)` inside the driver. Driver-only machinery stays
  off the public surface without a second store.
- The envelope slot is non-enumerable, which is safe in the leak direction and
  lossy in the carry direction. It never appears in `JSON.stringify`,
  `Object.keys`, or spread output — so internals cannot escape, and a spread
  copy silently drops the slot. `internalOf` then throws a `TypeError` on a
  result that looks identical. Prefer `ctx.patchResult`, which mutates in place
  and never changes the object reference. When you must replace the whole
  result, re-attach explicitly:

  ```ts
  // DON'T: the copy is not enveloped; the next internalOf() throws.
  ctx.setResult((cur) => ({ ...cur, status: "connected" }));

  // DO: carry the previous internal onto the replacement.
  ctx.setResult((cur) => Frond.carryInternal(cur, { ...cur, status: "connected" }));
  ```

```ts
// DON'T: dependency smuggled through a factory, work on the result,
// cancellation rebuilt by hand. Every line here is a consequence of the
// missing graph edge.
export function createCollectorDriver(options: { createHost?: () => Host } = {}) {
  const createHost = options.createHost ?? createRealHost;
  return Frond.Driver.Async<CollectorSpec>({
    acquire: Frond.Driver.Acquire(() =>
      Object.freeze({
        collect: (signal: AbortSignal) => collectSafely(createHost(), signal),
      })
    ),
  });
}

// DO: the dependency is an edge, the work is an action, the runtime owns
// cancellation. Test it by stubbing SourceNode.
actions: {
  collect: Frond.Driver.Action(async (ctx) => {
    const local = readLocalHints(); // leaf owned by this node
    const remote = await ctx.deps.source.read(ctx.signal).catch(() => ({}));
    return { ...local, ...remote };
  }),
}
```

## Driver Channels

| Channel | Runs | Result commit | Cleanup |
|---|---|---|---|
| `Acquire` | once per incarnation | returned value commits | cleans up its own partial failures |
| `Refresh` | on demand | staged only — the hook returns void | — |
| `Action` | per call, serialized through the node cell | only via `ctx.setResult` / `ctx.patchResult` | — |
| `Live` | while the node has live demand | none | `stop` disposes what `start` returned |
| `Release` | end of incarnation | — | tears down the result's capability |

- `Frond.Driver.Live({ start, stop })` is for continuous work — subscriptions,
  sockets, tick sources — never one-shot fetches. `start` returns the live
  resource; `stop` receives it and must dispose it. Liveness truth is
  node-owned demand; React component presence is never a liveness signal.
- Live hygiene: `stop` is idempotent (memoize the cleanup promise), and a
  live subscription stops accepting events *before* it propagates its own
  error or completion.
- Refresh is on-demand re-derivation. The runtime does not cascade refresh
  through dependents; a parent refreshing a direct dependency does it
  deliberately with `ctx.refreshDep("name")`.
- `ctx.disposers.add(fn)` registers incarnation-scoped cleanup for secondary
  listeners acquired mid-hook. The result's primary capability still tears
  down in `release`.
- Staging precedence: mutations staged through `setResult` /
  `setResultValidity` / `patchResult` commit when the hook succeeds. In
  `acquire` a defined return value supersedes the staged result (but not
  explicitly staged validity). `refresh` hooks return void — only staged
  mutations commit there — and action return values are always
  result-neutral.
- Effect-mode hooks also get `ctx.tryPromise` for promise interop, and both
  modes get `ctx.signals` for publishing typed runtime signals from drivers.

## Result Validity

Validity is how a node says "this result is still true", separately from
whether it exists. Declare the policy on the spec:

| `resultValidity` | Meaning |
|---|---|
| `{ _tag: "Static" }` | never goes stale; the default mental model |
| `{ _tag: "Manual" }` | the driver decides, via `ctx.setResultValidity` or a commit |
| `{ _tag: "TimeBound", staleAfter, expireAfter }` | the runtime ages it (Effect `Duration.Input`) |

Reads project `Current` / `Stale` / `Expired`. **Stale is not an error and not
a pending state** — the result is still readable, and consumers decide whether
to use it or trigger a refresh. Do not encode staleness as a result union
member; that is the runtime's model reimplemented on your surface.

When `acquire` needs to commit a result *and* its validity or load time in one
step, return `Frond.resultCommit(result, { validity, loadedAt })` instead of a
bare value:

```ts
acquire: Frond.Driver.Acquire(async (ctx) => {
  const { orders, fetchedAt } = await ctx.deps.transport.client.orders.list(ctx.signal);
  return Frond.resultCommit({ byId: indexById(orders) }, { loadedAt: fetchedAt });
}),
```

`loadedAt` is what a `TimeBound` policy ages from — supply the origin's
timestamp when the data was fetched earlier than this acquire (a cache, a
replayed snapshot), or the node reads as fresher than it is.

## Signals

`ctx.signals` publishes typed runtime signals on a channel. A channel is typed
by an event map (`interface CheckoutEvents { ... }`), names come from that map,
and payloads are checked at compile time — there is no runtime schema, because
a signal is built and consumed by the same application and never crosses a
trust boundary.

The rules that matter:

- **Signals are not a state channel.** They never satisfy readiness, never
  commit a result, and no consumer may treat a signal as the fact. State goes
  through the result; a signal announces that something happened.
- **Retention is a policy, not a guarantee.** `{ retention: "none" }` keeps
  nothing; `{ retention: "bounded", bufferSize }` keeps a window. An empty
  retained buffer is not evidence that nothing was published.
- **A subscriber failure is the subscriber's**. It surfaces as its own event
  and never fails the publishing driver.
- Retained records carry `sequence` and `recordedAt`; order by `sequence`.

## Cancellation

- `ctx.signal` is the operation's signal; pass it to everything the hook or
  action awaits. `ctx.nodeSignal` is the node incarnation's signal; use it for
  long-lived SDK listeners. Never retain `ctx.signal` past the operation.
- Abort stays cancellation. Never translate it into a domain failure, and
  never hand-roll `throwIfAborted` / `isAbortError` / synthetic `AbortError`
  plumbing — the runtime owns that.
- Merge `ctx.signal` with a caller-supplied signal via
  `AbortSignal.any([ctx.signal, input.signal])` — never by hand-wiring
  `addEventListener("abort", ...)` into a fresh controller.
- Actions take options where the contract needs them:
  `Frond.Driver.Action(run, { timeout: 5_000 })` or `timeout: "unbounded"`
  (skips only the deadline — stop, eviction, and caller interruption still
  interrupt). Admission is `"queue"` (default), `"reject"` (a second call
  fails while one is in flight), or `"join"` (equal inputs share one run).
- `admission: "reject"` guards one action against itself. Cross-action
  mutual exclusion (submit while a quote is in flight) is node-private state
  the colliding actions check — declare both layers when a flow needs them.
- All three admission policies still run through the node cell's serialized
  lane. Admission decides whether a call is *submitted*, never whether the
  cell runs two operations at once. It does not.

### Caller-Side Cancellation

Only one action channel accepts caller metadata. The typed facade
`handle.actions.foo(input)` takes input and nothing else — there is no signal
parameter on it. Metadata-bearing cancellation goes through the untyped
`handle.action(name, input, { signal })`, or through an Effect caller
interrupting its own fiber.

`metadata.signal` interrupts the submission exactly as fiber interruption
would, and what that means depends on what the call owns at the time:

| Ownership at abort | Outcome |
|---|---|
| Signal already aborted | settles as interruption; never submitted, driver never called |
| Queued, single owner | settles without invoking the driver |
| Active, single owner | the operation's `ctx.signal` aborts |
| Joined, another awaiter remains | the shared run continues for the others |

The call settles as Effect interruption; through `unwrapEffect` that is a
rejection carrying the interrupted `Cause`, distinguishable from a typed
failure like any other interruption. Cancelling is not a failure and never
enters a domain failure union.

### Manual Live Leases

Liveness is node-owned demand. React mounting a component is not demand, and
neither is a handle existing. When something outside MobX field observation
needs a node live — a background task, a composition-root warmup, a test —
take an explicit lease:

```ts
const held = await handle.acquireLiveLease(source, scope);
if (held._tag === "Held") {
  await held.lease.dispose(); // removes this demand source
}
```

`acquireLiveLease` answers `Held` (carrying a disposable lease and a live
demand snapshot), `Failure` (typed `GraphFailure`s; no lease was recorded), or
`NodeMissing`. Handle all three — a lease you assume you hold is a `Live`
`start` that never ran.

Disposing removes *one* demand source. Driver live resources stop only when
the combined demand becomes inactive or changes, so a disposed lease stops
nothing while another lease or an observing consumer still wants the node.

## Failures

- Expected domain failures are typed and recoverable: tagged error classes
  with a stable `_tag`, matched exhaustively. Defects fail loudly — never
  swallowed into a default branch.
- No handwritten error base classes, `instanceof` unions, or marker fields
  (`__isCustomError`, `__type`). No failure classification by message text.
- Caller-visible action outcomes surface to React as `operationFailure`;
  render-critical failures throw to the boundary. Never both for one failure.
- Cancellation is not a failure. It never appears in a domain failure union.

## Injection Seams And Platform Splits

Graph dependencies and spec overrides are the injection seams. Test-only
options are never one (see frond-node-testing).

**Platform split is a normal pattern, not an exception.** One node, one
carrier, one tag — and two implementation files resolved by the bundler:

```ts
// DO: one node, platform implementation leaves.
// readDeviceSnapshot.web.ts / readDeviceSnapshot.native.ts, one .d.ts contract
acquire: Frond.Driver.Acquire(async () => readDeviceSnapshot()),

// DO: when the whole driver differs per platform, split the driver instead.
// createDevicePlatformDriver.web.ts / .native.ts, consumed once:
static readonly spec = Frond.serviceSpec.fromDriver<DeviceSpec>({
  tag: Frond.tag("app/device"),
  key: () => Frond.Key.singleton(),
  driver: createDevicePlatformDriver(),
});
```

The class, spec shape, tests, and consumers stay single; only the touch of the
platform forks. When a split driver needs a standalone type, write
`Frond.NodeDescriptor<XSpec, "async">["driver"]` — the second parameter is
required; the bare default is the broad driver-mode union and will not satisfy
a flavored spec.

- A driver factory (`create*Driver(options)`) taking an options bag needs a
  real production caller passing non-default options — a composition-root
  injection the app actually performs. If only tests would pass options,
  delete the parameter and stub the dependency instead.
- `spec.fromDriver` / `Frond.specWithDriver` exist for platform splits,
  production driver injection, and intentionally shared pre-built drivers.
  Never inline-extract a driver just to name it.
- A `NodeDescriptor<Spec, mode>["driver"]` type alias in a node file is a
  symptom: the driver left the spec without one of the two reasons above.
- If a hook needs outside-world state, either depend on the node that owns it
  or become a leaf that owns it. A "host" object handed in through factory
  options is a dependency hiding from the graph.

## Resilient External Integrations

A leaf node wrapping a non-critical external capability (analytics, tracking,
attribution, third-party widgets) must degrade instead of blocking the graph:

- Ordinary startup failure stays an ordinary failure of the leaf, contained
  behind an internal deadline well under the runtime driver timeout — a
  quarter of it or less (5 seconds is the conventional cap).
- Cancellation never marks the integration degraded.
- The result exposes health explicitly: `operational | degraded | unsupported`.
  Consumers must not treat the node as optional; they read health.
- One best-effort diagnostic report per containment; a failing reporter never
  affects the committed result.
- Late settlement after the deadline is owned: cleaned up exactly once.
- Implement this through one shared containment helper per repository, and
  keep an executable inventory test proving every such node uses it.

## Imperative Host Capabilities

Capabilities born inside the UI tree (navigation containers, toast renderers,
imperative host chrome) do not get bind/unbind ports into the graph. The node
stays sealed and exposes intent as state; a bridge component owned by the
composition root executes and acknowledges it. See the frond-graph-topology
and frond-react skills. Bind/unbind host tokens are a migration-only shape.

## Pre-Graph Exceptions

Code that must run before the runtime exists is the narrowest sanctioned
escape from the graph. The membership test is one principle: **pre-graph
code must work when the graph does not — or will never — exist.** Anything
that merely feeds the graph about to exist is composition-root bootstrap,
not an exception.

Two closed groups, one open one:

1. **Polyfills and runtime prerequisites** — must exist before the Frond
   import itself evaluates. Examples: a `URL`/`crypto` polyfill, an
   import-side-effect library that must load first, intl data.
2. **Error reporting** — a crash/error SDK (Sentry, PostHog and their class)
   initialized before `createRuntime`, because graph-construction failure is
   precisely what it must capture. Error reporting is by definition not a
   graph node: a node cannot report the failure of the machinery that
   creates nodes. The pre-graph module owns initialization only; the graph
   may later mirror it (a runtime sink forwarding events, a passive
   projection node over the already-initialized SDK) but never
   re-initializes it.
3. **Everything else the host demands before the graph** — an open set,
   admitted case by case against the principle above, best judgment plus the
   checklist below; propose to the user when unsure.
   - DO: `SplashScreen.preventAutoHideAsync()` at module scope (Expo demands
     it before the first frame); `AppRegistry.registerHeadlessTask` /
     background message handlers in the entry file (the OS may invoke them
     with no graph ever existing); an orientation lock; dev-only tooling
     behind `__DEV__`.
   - DON'T: a one-process-lifetime SDK init to survive HMR — that is a leaf
     whose module holds a process-lifetime registry guard, not pre-graph
     code; reading config or assembling spec overrides — that is the
     composition root; anything justified by "the SDK is a singleton,"
     "it only runs once," React mount timing, current module placement, or
     avoiding a driver/cleanup contract. Module scope alone is not evidence.

Every pre-graph exception, no exceptions to the exceptions: lives in a named
module; carries a `// Pre-graph exception: <group>` comment; is
idempotent; reports its own async rejection; holds no domain state; exposes
its handle to the composition root, which hands it to the graph; cleans up
after itself; has a test.

## Named Patterns

Reach for these by name when the situation matches; do not reinvent them:

- **Probe extraction** — the "what is true right now" read lives in one
  function called identically from `acquire` and every refreshing action, so
  the two can never drift.
- **Generation fencing** — a monotonic generation number on a replaceable
  fact (credential, engine instance); every commit asserts it still owns the
  current generation, so late settlements and stale reads lose instead of
  overwriting.
- **Last-joiner cancellation** — for a shared process-lifetime installation:
  join each caller's abort signal; cancel the underlying work only when the
  last joined caller has cancelled.
- **Uninterruptible commit fences** (effect mode) — wrap each multi-step
  commit in `Effect.uninterruptible`, then check for interruption
  immediately after the fence, with an explicit compensating branch per
  already-committed step. A lost race must never leave a half-committed
  fact.

## Avoid

- Mode-less spec shapes and nested `driver:` fields in authored specs (pre-0.2).
- Generated-superclass authoring, standalone spec consts, ready-node aliases.
- Custom node base classes, package-local spec factory wrappers, re-export
  shims over `@frondruntime/core`.
- Test-only options parameters, `createHost`-style factory chains, DI-point
  indirection of any shape.
- Hand-rolled abort plumbing, including manual dual-signal joins where
  `AbortSignal.any` exists.
- Hand-rolled `Symbol()` + `Object.defineProperty` capsules for hidden result
  state — that is `withInternal` reinvented without its typing or test
  support.
- Pass-through class methods over `this.actions.*` / `this.result.*`.
- Local queues, timeout races, or result wrappers around the action lane.
- Copying a dependency's result fields into your own result during `acquire`
  (see frond-graph-topology: staleness).
- Separate `XDeps` / `XActions` / `XDriverContext` aliases that mirror one
  node's carrier.

## Checks

Run these against the consumer package under review — `src` means that
package's source directory, not a repo root. In a repo that also contains
`@frondruntime/*` package source, exclude it (e.g. `--glob '!packages/core/**'`).

```sh
rg "NodeDescriptor<[^>]+>\['driver'\]" src
rg "export function create\w+(Driver|Host)\(" src
rg "throwIfAborted|isAbortFailure|new Error\(.*[Aa]borted" src
rg "signal: AbortSignal" src   # in result/service types: action lane rebuilt by hand
rg "driver: Frond\.Driver\.(Async|Effect)<" src   # nested driver outside fromDriver
```

Every hit needs one of the two sanctioned reasons or a fix. Run the package
typecheck after authoring; run broader checks when public typing changed.

---

Describes: @frondruntime/core 0.4 (checked against .release-please-manifest.json by `bun run skills:check`)
