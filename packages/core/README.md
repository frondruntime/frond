# @frondruntime/core

Core Frond runtime package: node authoring, graph execution, lifecycle, diagnostics, signals, and test harnesses.

## Install

```sh
bun add @frondruntime/core effect mobx
```

`effect` is a peer dependency for Effect-facing driver and runtime APIs. `mobx` is a peer dependency because Frond node state is MobX-backed and must share the app's MobX runtime.

## What It Owns

- `createRuntime` and the runtime client.
- `NodeBase`, `NodeSpec`, the flavored spec factories (`nodeSpec.async` / `.effect`, same for `serviceSpec`, `resourceSpec`, `facadeSpec`), tags, keys, dependencies, and result commits.
- `Driver.Async` and `Driver.Effect` builders for pre-built or shared drivers (paired with `.fromDriver` and `specWithDriver`); inline authoring goes through the flavored factories.
- Graph/runtime types under `Frond.Graph`, `Frond.Runtime`, `Frond.Events`, `Frond.Signals`, and `Frond.Diagnostics`.
- Session-flow helpers: `readReady`/`ensureReadyNode` on node handles, single-flight void-input actions (`admission: "join"`), `runTransition`/`createTransition` for ordered multi-node sequences, and the `pendingOperations`/`isQuiescent` runtime reads.
- MobX-facing node helpers under `Frond.MobX`.
- Opt-in host utilities: the `withInternal`/`internalOf`/`carryInternal` result envelope for hidden imperative internals, and `createRuntimeCoordinator` for serialized runtime replacement (dev HMR, test isolation).
- Testing helpers under `@frondruntime/core/testing`.

## Minimal Node

```ts
import * as Frond from "@frondruntime/core";

type SessionSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: { readonly userId: string | null };
}>;

export class SessionNode extends Frond.NodeBase<SessionSpec> {
  static readonly spec = Frond.serviceSpec.async<SessionSpec>({
    tag: Frond.tag("app/session"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(async () => ({ userId: null })),
  });

  get isSignedIn(): boolean {
    return this.result.userId !== null;
  }
}
```

The driver mode is declared once, in the spec shape (`readonly mode: "async" | "effect"`). The factory flavor must agree - `.async` requires `mode: "async"`, `.effect` requires `mode: "effect"` - and `NodeBase<Spec>` derives the node's action surface from the shape, so the three can never disagree.

Driver hooks receive two abort signals. `ctx.signal` is operation-scoped: it aborts when the current acquire/refresh/action is interrupted or times out. `ctx.nodeSignal` is node-lifetime: one per ready-node incarnation, created before acquire runs and aborted exactly once when the incarnation closes (release, eviction, ready invalidation, runtime stop). Bind long-lived callbacks registered during acquire - subscriptions, external listeners - to `nodeSignal`; use `signal` to cancel the operation's own in-flight work.

## Runtime Usage

```ts
const runtime = Frond.createRuntime();
const session = runtime.client.node(SessionNode, Frond.Args.none);

await session.ensureReady();
const read = session.read();
```

Only ready reads expose the authored node instance. Pending, error, invalid, unavailable, and unwired reads expose lifecycle data, not partial node objects. A `Ready` read is fully typed: `read.result` is exactly the declared result type (never `| undefined`), and `read.node` is the authored class instance - no casts.

When a call site wants the typed node or a thrown error instead of a tagged read, the handle offers a ready-or-throw projection:

```ts
// Sync: Ready returns the typed node instance, Error rethrows the read's
// underlying error, and unwired/idle/pending throw the typed
// Runtime.FrondNodeNotReady (carries nodeId, tag, readiness).
const node = session.readReady();

// One awaited readiness attempt (ensureReady) followed by the same projection.
const ready = await session.ensureReadyNode();
```

`readReady` never schedules graph work; `ensureReadyNode` replaces hand-rolled read-ready-or-throw wrappers and their bespoke error classes.

For subscriptions outside the React adapter, a handle pairs `subscribe` with `readVersion`: `session.readVersion()` returns the revision of the node's committed state, stable across calls when nothing changed, so it serves as the `getSnapshot` half of a `useSyncExternalStore`-style integration instead of hashing `read()` by hand. The revision stays monotonic across evictions within one runtime: a re-created node continues past its predecessor's revision, so no previously observed version can recur.

## Session Flow

A void-input action can declare join admission - `Frond.Driver.Action(run, { admission: "join" })` - so concurrent invocations single-flight on a constant per-node/action key and all share the one in-flight result:

```ts
expire: Frond.Driver.Action(async () => performSignOut(), { admission: "join" }),
```

Input-bearing actions still require `admissionKey(input)`; void-input join rejects an explicit `admissionKey` at compile time.

Ordered multi-node sequences - sign-out, session expiry - go through `runTransition`/`createTransition`:

```ts
const signOut = Frond.createTransition(
  [
    { label: "expire-session", run: () => session.actions.expire() },
    { label: "clear-caches", run: () => clearCaches() },
  ],
  { onStepFailure: "continue" }
);

const outcome = await signOut(); // concurrent calls join the in-flight run
if (!outcome.ok) {
  report(outcome.failures); // each failed step's label and cause
}
```

Steps run strictly in order and may return a Promise or a self-contained Effect. One failure policy applies to the whole run: `"abort"` stops at the first failure and skips the rest, `"continue"` runs every step and collects each failure (the best-effort tail). The returned Promise never rejects - the `TransitionOutcome` record reports `completed`, `failures`, and `ok`. Deliberately minimal: no per-step timeouts, compensation, or resumability.

For observability, `runtime.pendingOperations()` lists the nodes whose current operation is `Running` (`{ nodeId, tag, operation }`), and `runtime.isQuiescent()` is the same instantaneous read as a boolean. Both are projections of data `getSnapshotSync()` already carries - observability reads, NOT an await-quiescence barrier: operations may start or settle between the read and any code acting on it.

## Interop

Node actions are mode-native: an effect-mode node's actions return `Effect`, an async-mode node's actions return `Promise`. `unwrapEffect` and `wrapPromise` cross that boundary in either direction.

```ts
// Call an effect-mode action from Promise/React code.
await Frond.unwrapEffect(session.actions.refreshToken({ force: true }));

// Call an async-mode action (or any outside Promise) from an Effect pipeline.
yield* Frond.wrapPromise(() => profile.actions.rename({ name }));
```

## Testing

```ts
import * as FrondTest from "@frondruntime/core/testing";
```

The testing subpath includes runtime harnesses, deferred drivers, and spec helpers used to test node behavior without React.

## Migrating

Upgrading from 0.1.0? The complete breaking-change list with before/after snippets is in [MIGRATION-0.2.md](./MIGRATION-0.2.md).

## Docs

- Install: https://frondruntime.dev/docs/start/install
- First node: https://frondruntime.dev/docs/start/first-node
- Public surface: https://frondruntime.dev/docs/reference/public-surface

Release notes for this package are generated from Conventional Commits.
Squash-merged PR titles provide the release-note subject for this package.
Release smoke tests verify GitHub release metadata before npm publishing.

## AI use

Frond is AI-assisted (mainly Claude and Codex), iterated over months rather than one-shot generated. Full note: https://frondruntime.dev/ai-use
