# Migrating from 0.1.0 to 0.2.0

0.2.0 makes node authoring one-declaration: the driver mode lives in the spec shape, the spec factories are mode-flavored and flattened, and everything downstream (the class, the action surface, typed reads) derives from the shape. This guide lists every breaking change with before/after snippets, then the additive surface worth adopting.

Applies to `@frondruntime/core` and `@frondruntime/react`. Changes that shipped in the 0.1.0 hardening train (canonical args, result staging, the snapshot API losing its purpose parameter, the removal of the `RuntimeEvents` constructor namespace, and friends) are not re-documented here - see the [0.1.0 release notes](./CHANGELOG.md#010-2026-07-15).

## Breaking changes

### 1. Flavored, flattened spec factories

`nodeSpec`, `serviceSpec`, `resourceSpec`, and `facadeSpec` are now `{ async, effect, fromDriver }` factories. The driver hooks move up into the factory input - there is no `driver:` field and no inline `Driver.Async(...)` / `Driver.Effect(...)` wrapper for authored nodes.

```ts
// 0.1.0
static readonly spec = Frond.serviceSpec<SessionSpec>({
  tag: Frond.tag("app/session"),
  key: () => Frond.Key.singleton(),
  driver: Frond.Driver.Async<SessionSpec>({
    acquire: Frond.Driver.Acquire(async () => ({ userId: null })),
  }),
});

// 0.2.0
static readonly spec = Frond.serviceSpec.async<SessionSpec>({
  tag: Frond.tag("app/session"),
  key: () => Frond.Key.singleton(),
  acquire: Frond.Driver.Acquire(async () => ({ userId: null })),
});
```

Effect-native nodes use `.effect` the same way. `Driver.Async` / `Driver.Effect` remain public for pre-built or shared drivers; pass the result through `nodeSpec.fromDriver` (or `specWithDriver`, below). Both builders and `.fromDriver` carry the same shape-mode constraint as the factories: the driver's mode literal must agree with the shape-declared mode.

### 2. Spec shapes must declare `mode`

Every `NodeSpec` shape declares its driver mode as its first member: `readonly mode: "async"` or `readonly mode: "effect"`. A shape without `mode` no longer typechecks, and each factory flavor rejects a shape whose mode disagrees (`.async` requires `mode: "async"`, `.effect` requires `mode: "effect"`).

```ts
// 0.1.0
type SessionSpec = Frond.NodeSpec<{
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: SessionResult;
}>;

// 0.2.0
type SessionSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: SessionResult;
}>;
```

This is the single declaration point: the factory flavor must agree with it, and `NodeBase` derives the class's action surface from it.

### 3. `NodeBase` takes a single type parameter

`NodeBase<Spec>` is the only form. The mode comes from the spec shape, so there is no second type argument - `NodeBase<Spec, "effect">` (from the unreleased 0.2.0 pre-release builds that introduced mode-native actions) is rejected. If you never tracked pre-release builds, your 0.1.0 `NodeBase<Spec>` classes are already in the right shape; add `mode` to the spec shape and you are done.

```ts
// 0.2.0 pre-release interim (rejected in 0.2.0)
class RefreshNode extends Frond.NodeBase<RefreshSpec, "effect"> { ... }

// 0.2.0
class RefreshNode extends Frond.NodeBase<RefreshSpec> { ... }
```

### 4. The effect factories' requirements generic is removed

`Driver.Effect` (and the `.effect` factory flavor) no longer take an `R` requirements parameter - 0.1.0 already pinned it to `never`, and 0.2.0 deletes the position entirely. Effect hooks must be self-contained (`Effect.Effect<A, E>` with no remaining requirements). If you spelled out an explicit action map, it shifts up one position:

```ts
// 0.1.0
serviceSpec<RefreshSpec>({
  ...,
  driver: Driver.Effect<RefreshSpec, never, typeof refreshActions>({ ..., actions: refreshActions }),
});

// 0.2.0 - no middle `never`
serviceSpec.effect<RefreshSpec, typeof refreshActions>({ ..., actions: refreshActions });
```

The same shift applies to `Driver.Effect<Spec, typeof actions>` when building a shared driver.

### 5. Actions are mode-native

In 0.1.0, `node.actions.*` always returned a `Promise`. In 0.2.0 the action surface follows the driver's authored mode end to end: an async-mode node's actions return `Promise`, an effect-mode node's actions return `Effect`. There is one call surface per node; cross the boundary explicitly with `unwrapEffect` / `wrapPromise`.

```ts
// 0.1.0 - every action awaited as a Promise
await session.actions.refreshToken({ force: true });

// 0.2.0 - async-mode node: unchanged
await profile.actions.rename({ name });

// 0.2.0 - effect-mode node from Promise/React code: bridge with unwrapEffect
await Frond.unwrapEffect(session.actions.refreshToken({ force: true }));

// 0.2.0 - effect-mode node inside an Effect pipeline: compose directly
yield* session.actions.refreshToken({ force: true });
```

`unwrapEffect` rejects with the original typed error value (so `catch` sees what the Effect failed with); defects and interruption reject with the failure `Cause` so crashes never masquerade as typed failures. The MobX and React adapters bridge internally - hooks like `useNode` and the MobX helpers need no changes at call sites that only render or read nodes.

### 6. `Ready.result` is exactly the declared result type

`RuntimeNodeRead`'s `Ready.result` (and `Ready` in `RuntimeNodeSnapshot`) is `TResult`, no longer `TResult | undefined`. Every path that commits the Ready phase carries a committed result, so the `undefined` widening was a phantom state. Delete the compensations:

```ts
// 0.1.0
if (read._tag === "Ready") {
  return read.result?.displayName ?? "";
}

// 0.2.0
if (read._tag === "Ready") {
  return read.result.displayName;
}
```

`result === undefined` remains representable only when `undefined` is a member of your declared result type.

### 7. `read().node` is the typed class instance

Typed handles (`runtime.client.node(SessionNode, args)` and the React hooks) now thread the authored class through reads: `Ready.node` is the node class instance, not `object`. Delete the casts:

```ts
// 0.1.0
const node = read.node as SessionNode;

// 0.2.0
const node = read.node; // already SessionNode
```

The same typing flows through `handle.snapshot()` lookups and the new `RuntimeHandleNode<TSpec>` alias (see below).

### 8. Handle and read types gained type parameters

Only affects code that spells out all type arguments; inference and partially-applied forms are unchanged.

- `RuntimeNodeHandle<TArgs, TResult>` is now `RuntimeNodeHandle<TArgs, TResult, TActions = Record<string, never>, TMode = "async", TNode = object>`.
- `RuntimeNodeRead<TResult>`, `RuntimeNodeSnapshot<TResult>`, and `RuntimeNodeSnapshotLookup<TResult>` gained a trailing `TNode extends object = object` parameter.

If you aliased these with explicit arguments, append the new parameters (or drop the explicit spelling and let `client.node(Spec, args)` infer everything from the spec).

### 9. Inherited 0.1.0 breaking changes

The snapshot API and event constructor changes (plus canonical args and result staging) shipped in 0.1.0 and are unchanged in 0.2.0. If you are jumping from 0.0.x, read the [0.1.0 release notes](./CHANGELOG.md#010-2026-07-15) first.

## Deferred surface

The requirements channel is deferred, not dead: the effect factories' requirements parameter is removed; the R channel returns as ambient runtime services — hook signatures widen additively, no authoring change. The `services` member of the spec shape is reserved for that proposal and is ignored today. In the interim, host-boundary injection (host callbacks and other non-canonical inputs that must reach a driver) goes through `specWithDriver`.

## Additive 0.2.0 surface

Nothing here requires migration; adopt as needed.

- **`specWithDriver(Original, driver)`** - production spec override that swaps only the driver, preserving tag, key, kind, dependencies, and class identity (`instanceof Original` keeps working). Pair with `createRuntime({ specOverrides })`.
- **Result envelope: `withInternal` / `internalOf` / `carryInternal`** - a Frond-owned non-enumerable slot for imperative per-node internals (SDK handles, sockets) that never leaks into serialization, spreads, or projections.
- **`createRuntimeCoordinator`** - serialized runtime replacement for dev HMR and test isolation; boot/dispose of runtime generations never overlap. Pairs with `RuntimeLease` and `RuntimeBootSupersededError`.
- **`ctx.nodeSignal`** - node-lifetime `AbortSignal` on driver contexts, one per ready-node incarnation, for subscriptions and long-lived callbacks; `ctx.signal` stays operation-scoped.
- **`RuntimeHandleNode<TSpec>`** - the ready node instance type a typed handle exposes; useful for typing helpers around `handle.read()`.
- **`DisposerTimedOut`** - structured cause (wrapped in `DisposerFailed`) for async disposers that outlive the per-disposer `driverTimeouts.release` bound; disposers are now once-only and shutdown never wedges on a hung disposer.
- **`StartInterrupted`** - a `LiveResourceStopReason` for live resources whose start raced an interrupt; live-start/stop is atomic, so a raced start is always stopped.
- **`useNodeRead` (react)** - non-throwing tagged read (`Unwired | Idle | Pending | Ready | Error`) for components that render every state inline instead of delegating to Suspense/error boundaries.

Also of note: `wrapPromise` now hands the thunk an `AbortSignal` wired to Effect interruption, `handle.readVersion()` stays monotonic across evictions within one runtime, and `eventBufferSize: 0` now retains truly zero events.
