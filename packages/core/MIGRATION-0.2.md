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

Effect-native nodes use `.effect` the same way. `Driver.Async` / `Driver.Effect` remain public for pre-built or shared drivers; pass the result through `nodeSpec.fromDriver` (or `specWithDriver`, below). Both builders and `.fromDriver` carry the same shape-mode constraint as the factories: the driver's mode literal must agree with the shape-declared mode, and a shape whose `mode` is still the full `"async" | "effect"` union is rejected by all three - `fromDriver` names the failure explicitly (`fromDriver requires a spec shape declaring a single mode: "async" or "effect"`). Mode-generic override helpers hit that rejection and must route through `specWithDriver` instead; see §11.

This applies to the four spec factories only. The testing entrypoint is unchanged: `mockSpec` and `readySpec` from `@frondruntime/core/testing` still take `{ driver?, dependencies? }` overrides, and an inline `Driver.Async<Spec>({ ... })` / `Driver.Effect<Spec>({ ... })` body is still the correct spelling there. Existing test call sites need no migration - do not "flatten" them.

```ts
// 0.2.0 - unchanged from 0.1.0
const MockSession = mockSpec(SessionNode, {
  dependencies: () => ({}),
  driver: Frond.Driver.Async<SessionSpec>({
    acquire: Frond.Driver.Acquire(async () => ({ userId: "u1" })),
  }),
});
```

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

`Driver.Effect` (and the `.effect` factory flavor) no longer take an `R` requirements parameter - 0.1.0 already pinned it to `never`, and 0.2.0 removes it from every authoring position. Effect hooks must be self-contained (`Effect.Effect<A, E>` with no remaining requirements). If you spelled out an explicit action map, it shifts up one position:

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

The position is gone from authoring, not from the type system: the internal `EffectDriver` type still carries a trailing `R extends never = never` slot. That retention is deliberate - it is the reserved expansion point for the deferred requirements channel (see "Deferred surface"), not a parameter you can pass today. Nothing public accepts an `R` argument in 0.2.0.

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

`unwrapEffect` rejects with the original typed error value (so `catch` sees what the Effect failed with); defects and interruption reject with the failure `Cause` so crashes never masquerade as typed failures.

The MobX and React adapters bridge internally, so `useNode`, `useNodeRead`, and the MobX helpers need no changes - but only where a call site renders or reads. Every React call site that invokes an effect-mode action does need changing, and in an effect-mode codebase that is the bulk of the migration by line count. An action call now builds an `Effect` and runs nothing:

```tsx
// 0.1.0 - the call ran the action
// 0.2.0 - effect-mode: still typechecks, builds an Effect, and silently never runs
<button onClick={() => void session.actions.refreshToken({ force: true })} />

// 0.2.0 - run it at the React boundary
<button
  onClick={() => void Frond.unwrapEffect(session.actions.refreshToken({ force: true }))}
/>
```

This one is silent: the stale spelling still compiles, so the compiler will not find these for you. Sweep every `onClick`/`onSubmit`/effect-hook body that touches an effect-mode node's `actions`. Async-mode nodes are unaffected.

### 6. MobX observable results are classified non-plain for `patchResult` staging

`patchResult` clones plain objects and arrays before running the recipe so failed operations can roll back staged mutations. In 0.1.0, a MobX observable result slipped through that classification: patching it silently staged a plain-object snapshot, and a committed patch could replace the observable with the de-observabilized copy. 0.2.0 enforces the `ResultPatchOptions` contract that was already documented - an observable (or any class-instance) result is non-plain, and a patch without `resultPatch: { nonPlainClone: ... }` fails loudly (`driver patchResult requires resultPatch.nonPlainClone for non-plain result values`) instead of committing a fake observable.

```ts
// 0.1.0 - patching an observable result silently staged a plain snapshot
ctx.patchResult((draft) => {
  draft.count += 1;
});

// 0.2.0 - declare staging semantics on the driver, or the patch fails loudly
static readonly spec = Frond.serviceSpec.effect<CounterSpec>({
  tag: Frond.tag("app/counter"),
  key: () => Frond.Key.singleton(),
  resultPatch: { nonPlainClone: "share" },
  acquire: Frond.Driver.Acquire(() => Effect.succeed(observable({ count: 0 }))),
});
```

Choose the semantics deliberately: use `"share"` only when shared-reference staging is acceptable - recipe mutations are visible immediately, and if the operation later fails the mutation remains observable on the failed node's result because the stored result is the same shared reference. Provide a clone function when the result type has a domain-specific copy operation and you need real staging isolation. Or sidestep `patchResult` entirely and mutate through node domain methods.

### 7. `Ready.result` is exactly the declared result type

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

### 8. `read().node` is the typed class instance

Typed handles (`runtime.client.node(SessionNode, args)` and the React hooks) now thread the authored class through reads: `Ready.node` is the node class instance, not `object`. Delete the casts:

```ts
// 0.1.0
const node = read.node as SessionNode;

// 0.2.0
const node = read.node; // already SessionNode
```

The same typing flows through `handle.snapshot()` lookups and the new `RuntimeHandleNode<TSpec>` alias (see below).

This only lands once the surrounding handle annotation is gone. An explicit `RuntimeNodeHandle<TArgs, TResult>` pins `TNode` to its `object` default, so `read.node` stays `object` however the node was authored and deleting the cast fails (`Type 'object' is not assignable to type 'SessionNode'`). Drop the annotation first - see §9.

### 9. Handle, read, and descriptor types gained type parameters

- `RuntimeNodeHandle<TArgs, TResult>` is now `RuntimeNodeHandle<TArgs, TResult, TActions = Record<string, never>, TMode = "async", TNode = object>`.
- `NodeDescriptor<TSpec>` is now `NodeDescriptor<TSpec, TMode extends DriverMode = DriverMode>`.
- `RuntimeNodeRead<TResult>`, `RuntimeNodeSnapshot<TResult>`, and `RuntimeNodeSnapshotLookup<TResult>` gained a trailing `TNode extends object = object` parameter.

Partially-applied spellings are not safe. The new defaults are concrete, not inferred, so an annotation that omits them actively conflicts with what `client.node` returns: `TActions` is pinned to `Record<string, never>`, `TMode` to `"async"`, `TNode` to `object`. The assignment is rejected as soon as the node declares actions (or is effect-mode); an action-less async node happens to still line up, which makes this fail unevenly across a codebase.

```ts
// 0.1.0 partially-applied annotation - rejected in 0.2.0 with
// error TS2322 ... Types of property 'actions' are incompatible.
const counter: Frond.Runtime.RuntimeNodeHandle<Frond.Args.None, CounterResult> =
  runtime.client.node(CounterNode, {});

// 0.2.0 - delete the annotation; the spec drives every parameter
const counter = runtime.client.node(CounterNode, {});
```

Prefer deleting the explicit spelling over appending arguments to it: `client.node(Spec, args)` infers args, result, actions, mode, and node instance from the spec, so there is nothing left to keep in sync.

`NodeDescriptor` needs the opposite treatment, because the common consumer idiom is a driver type alias and there is nothing to infer from:

```ts
// 0.1.0
type SessionDriver = Frond.NodeDescriptor<SessionSpec>["driver"];

// 0.2.0 - one argument leaves `TMode` at the full `DriverMode` union
type SessionDriver = Frond.NodeDescriptor<SessionSpec, "async">["driver"];
```

Pin the mode. Left unpinned, the alias no longer satisfies a mode-flavored factory (`Type 'DriverMode' is not assignable to type '"async"'`) - and the error lands on the call site that consumes the driver, never on the alias, so it is otherwise undiscoverable.

### 10. `client.node` takes one type parameter

0.1.0's `client.node<TArgs, TResult>(spec, args)` is now `client.node<TSpec extends NodeSpecLike>(spec, args)`. Call sites that spelled the old pair out fail with `error TS2558: Expected 1 type arguments, but got 2.`

```ts
// 0.1.0
const session = runtime.client.node<Frond.Args.None, SessionResult>(SessionNode, {});

// 0.2.0 - delete the type arguments
const session = runtime.client.node(SessionNode, {});
```

Note the direction, because it is the reverse of §9: the types there gained parameters, so explicit aliases may need more arguments; `client.node` lost parameters, so its call sites need fewer. Do not answer a TS2558 here by appending a third argument.

### 11. Mode-generic spec overrides go through `specWithDriver`

`nodeSpec.fromDriver` (§1) requires a spec shape whose `mode` has already narrowed to a single literal. A helper that derives an override generically over an unknown original spec cannot satisfy that: its shape's `mode` is still `NodeSpecMode<TOriginal>`, a type parameter, so the declared-mode guard rejects the input (`... is not assignable to type 'RequireDeclaredMode<DerivedNodeSpec<TOriginal>>'`).

```ts
type DerivedNodeSpec<TOriginal extends Frond.NodeSpecLike> = Frond.NodeSpec<{
  readonly mode: Frond.NodeSpecMode<TOriginal>;
  readonly args: Frond.NodeSpecArgs<TOriginal>;
  readonly key: Frond.NodeSpecKey<TOriginal>;
  readonly deps: Frond.NodeSpecDeclaredDeps<TOriginal>;
  readonly result: Frond.NodeSpecResult<TOriginal>;
  readonly actions: Frond.NodeSpecActions<TOriginal>;
}>;

// 0.2.0 - rejected: the shape's mode is still a type parameter
export function deriveDriverSpec<TOriginal extends Frond.NodeSpecLike>(
  tag: Frond.NodeTag,
  key: (args: Frond.NodeSpecArgs<TOriginal>) => Frond.NodeSpecKey<TOriginal>,
  driver: Frond.NodeDescriptor<DerivedNodeSpec<TOriginal>, Frond.NodeSpecMode<TOriginal>>["driver"]
) {
  return Frond.nodeSpec.fromDriver<DerivedNodeSpec<TOriginal>>({ tag, key, driver });
}

// 0.2.0 - specWithDriver carries no declared-mode guard
export function deriveDriverSpec<TOriginal extends Frond.NodeSpecLike>(
  original: TOriginal,
  driver: Frond.SpecWithDriverReplacement<TOriginal>
): Frond.SpecWithDriverClass<TOriginal> {
  return Frond.specWithDriver(original, driver);
}
```

`specWithDriver` also preserves tag, key, kind, dependencies, and class identity, so the derived override stays interchangeable with the original. For this pattern it is a required migration path, not an optional adoption.

Related: the 0.1.0 type-level idiom `Parameters<typeof Frond.nodeSpec<T>>[0]` no longer resolves. `nodeSpec` is a const object (a `NodeSpecFactory`), not a generic function, so instantiating it fails with `error TS2635: Type 'NodeSpecFactory' has no signatures for which the type argument list is applicable.` The flavored input types are not public; derive the driver from `NodeDescriptor<TSpec, TMode>["driver"]` and call the factory directly instead.

### 12. Inherited 0.1.0 breaking changes

The snapshot API and event constructor changes (plus canonical args and result staging) shipped in 0.1.0 and are unchanged in 0.2.0. If you are jumping from 0.0.x, read the [0.1.0 release notes](./CHANGELOG.md#010-2026-07-15) first.

## Deferred surface

The requirements channel is deferred, not dead: the effect factories' requirements parameter is removed; the R channel returns as ambient runtime services — hook signatures widen additively, no authoring change. The `services` member of the spec shape is reserved for that proposal and is ignored today. In the interim, host-boundary injection (host callbacks and other non-canonical inputs that must reach a driver) goes through `specWithDriver`.

## Additive 0.2.0 surface

Adopt as needed - with one exception, called out first below.

- **`specWithDriver(Original, driver)`** - production spec override that swaps only the driver, preserving tag, key, kind, dependencies, and class identity (`instanceof Original` keeps working). Pair with `createRuntime({ specOverrides })`. Not always optional: it is the required path for mode-generic override helpers (§11) and for host-boundary injection (see "Deferred surface").
- **Result envelope: `withInternal` / `internalOf` / `carryInternal`** - a Frond-owned non-enumerable slot for imperative per-node internals (SDK handles, sockets) that never leaks into serialization, spreads, or projections.
- **`createRuntimeCoordinator`** - serialized runtime replacement for dev HMR and test isolation; boot/dispose of runtime generations never overlap. Pairs with `RuntimeLease` and `FrondRuntimeBootSuperseded`.
- **`ctx.nodeSignal`** - node-lifetime `AbortSignal` on driver contexts, one per ready-node incarnation, for subscriptions and long-lived callbacks; `ctx.signal` stays operation-scoped.
- **`RuntimeHandleNode<TSpec>`** - the ready node instance type a typed handle exposes; useful for typing helpers around `handle.read()`.
- **`DisposerTimedOut`** - structured cause (wrapped in `DisposerFailed`) for async disposers that outlive the per-disposer `driverTimeouts.release` bound; disposers are now once-only and shutdown never wedges on a hung disposer.
- **`StartInterrupted`** - a `LiveResourceStopReason` for live resources whose start raced an interrupt; live-start/stop is atomic, so a raced start is always stopped.
- **`useNodeRead` (react)** - non-throwing tagged read (`Unwired | Idle | Pending | Ready | Error`) for components that render every state inline instead of delegating to Suspense/error boundaries.
- **Void-input join admission** - `Driver.Action(run, { admission: "join" })` is now legal for void-input actions (`ActionContract<void, T>`): concurrent invocations single-flight on a constant per-node/action key and all share the one in-flight result (an awaiter's interruption never aborts the shared run; a call after settlement runs fresh). Input-bearing actions still require `admissionKey(input)`, and void-input join rejects `admissionKey` at compile time.
- **`handle.readReady()` / `handle.ensureReadyNode(metadata?)`** - sync ready-or-throw projection of a node handle: `Ready` returns the typed node instance, `Error` rethrows the read's underlying error, and unwired/idle/pending throw the typed `Runtime.FrondNodeNotReady` (carries `nodeId`, `tag`, `readiness`); `ensureReadyNode` is one awaited `ensureReady` followed by the same projection - replaces hand-rolled read-ready-or-throw wrappers and their bespoke error classes.
- **`runtime.pendingOperations()` / `runtime.isQuiescent()`** - instantaneous sync projection of nodes with a `Running` operation (`{ nodeId, tag, operation }`), derived from data `getSnapshotSync()` already carries. An observability/barrier-building read, deliberately NOT an await-quiescence primitive (drain admission policy is a 0.3.0 design question).
- **Quality-pass surface** - every `RuntimeNodeRead` variant now carries an optional `tag` (the node tag whenever the read projected a reachable snapshot; sentinel reads - a never-materialized unwired node, a stopped runtime - report `undefined`); `runtime.readNodeRevisionSync(nodeId)` joins the sync facade as the narrow monotonic-revision read backing `handle.readVersion()`; `AnyModeSpec` names the any-mode spec bound for mode-generic helpers around the factories; and the testing subpath adds `effectHostFromRuntime` / `effectBridgeRunner` for rebuilding a runtime client over a wrapped Promise facade without hand-rolled host literals.
- **`metadata.signal` — caller cancellation for Promise-facing action calls** - `RuntimeWorkMetadata` gains an optional `signal: AbortSignal`, honored by `handle.action(name, input?, metadata?)`. Aborting it interrupts the submission exactly as if the caller's Effect fiber were interrupted: queued work settles without invoking the driver, active single-owner work aborts its operation `ctx.signal`, join-admission work keeps running for its other awaiters, and an already-aborted signal settles as interruption without submitting. The cancelled call settles with Effect interruption, so `unwrapEffect(handle.action(...))` rejects with the interrupted `Cause` (distinguishable from typed failures). The typed `handle.actions.*` facades intentionally take no signal parameter in 0.2 - metadata-bearing cancellation goes through `handle.action` (or an Effect caller interrupting its own fiber); typed sugar can come later.
- **`runTransition` / `createTransition`** - ordered multi-node transition steps with an `"abort" | "continue"` failure policy, a never-throwing `TransitionOutcome` record, and single-flight invocation - replaces hand-rolled sign-out/session-expiry sequences and best-effort tails. Deliberately minimal: no per-step timeouts, compensation, or resumability (that scope belongs to the workflows design).

Also of note: `wrapPromise` now hands the thunk an `AbortSignal` wired to Effect interruption, `handle.readVersion()` stays monotonic across evictions within one runtime, and `eventBufferSize: 0` now retains truly zero events.
