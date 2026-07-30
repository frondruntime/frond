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
- The signal bus: `Signals.defineChannel` (optionally typed by an event map), `runtime.publish`, `runtime.subscribeSignals`, and `ctx.signals` inside drivers.
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

## Signals

Signals are an in-process, best-effort message bus, deliberately outside the graph. A domain event that several parts of an app care about - `checkout.completed`, `session.expired` - travels without becoming somebody else's node result or a chain of action calls, and devtools sees it as its own event category rather than as generic runtime noise.

A channel declares what it carries as a type map, and `defineChannel` types the channel by it:

```ts
interface CheckoutEvents {
  "checkout.started": { readonly cartId: string; readonly total: number };
  "checkout.completed": { readonly orderId: string };
  "app.opened": void; // an event that carries nothing
}

export const Checkout = Frond.Signals.defineChannel<CheckoutEvents>({
  name: "app.checkout",
  policy: { retention: "bounded", bufferSize: 256 },
});

const runtime = Frond.createRuntime({ channels: [Checkout] });
```

`Checkout.signal` accepts only declared names, each with the payload its map entry declares. An event typed `void` takes no payload argument at all, and a name the map does not contain is a compile error rather than a message nobody is subscribed to:

```ts
await runtime.publish(Checkout.signal("checkout.started", { cartId, total }));
await runtime.publish(Checkout.signal("app.opened"));
```

The map is types only. Nothing decodes at publish time: a signal payload is built by the same application that consumes it, so a runtime check would spend work re-discovering a mistake the compiler already refused to compile. Omitting the type argument keeps the untyped channel - any name, an `unknown` payload - so existing channels need no change, and channels can be typed one at a time.

### Subscribing from a node

`Checkout.subscriber` builds a subscriber pinned to its own channel and hands the handler a record that narrows per branch. Registered in `acquire` and torn down through `ctx.disposers`, that is the whole analytics-node recipe:

```ts
acquire: Frond.Driver.Acquire((ctx) =>
  Effect.gen(function* () {
    const store = observable({ orders: 0 }); // the node's result; observable so React re-renders

    const subscription = yield* ctx.signals.subscribe(
      Checkout.subscriber({
        name: "analytics",
        handle: (record) =>
          Effect.gen(function* () {
            switch (record.signal.name) {
              case "checkout.completed": {
                // Narrowed to this branch's payload: orderId, no cast.
                track(record.signal.payload.orderId);
                yield* ctx.deps.orders.actions.counted({ by: 1 });
                break;
              }
              case "checkout.started":
              case "app.opened": {
                break;
              }
            }
          }),
      })
    );

    ctx.disposers.add(subscription.unsubscribe);
    return store;
  })
),
```

Two things that recipe leans on. `ctx.disposers` binds the subscription to the node incarnation, so it is torn down on release, eviction, or runtime stop instead of outliving the node that owns it. And a handler that needs to reach graph state does it by invoking an action on a *declared dependency* - `ctx.deps.orders` above - which is the same discipline every other outside-the-graph callback follows: the target's cell actor serializes the action, so a burst of signals cannot interleave halfway through an update.

The per-branch narrowing is a projection of the delivery filter rather than a claim: `subscriber` pins `channels` to this channel, and the bus filters delivery by exactly that field. A subscriber assembled by hand without `channels` receives every channel's traffic and correctly gets the wide `RuntimeSignalRecord`. For consumers outside the graph entirely, `runtime.subscribeSignals(subscriber)` takes the same value and returns the same `unsubscribe`.

### What delivery costs

`publish` awaits its subscribers, one at a time, before it resolves. That is what lets a resolved publish mean "every subscriber has run", and it is also the cost: a slow handler delays the publisher and every subscriber behind it. Keep handlers short and fork what is not (`Effect.forkDetach`, or a queue the node drains on its own). A handler that fails does not fail the publish - the failure is reported as a `RuntimeSignalSubscriberFailureObserved` event naming both the subscriber and the signal, and delivery continues to the rest.

### The dispatcher node

A channel constant is a module singleton, so it cannot hold anything that varies per session. Analytics wants exactly the opposite: a session id, the current screen, and the signed-in user on every event. That envelope is the part a module constant has nowhere to keep, and threading it through each call site instead is how it goes stale. The fix is to bind dispatch to the runtime by putting it behind a node, where the envelope lives in the node incarnation and is released with it.

The dispatch method goes on the node's *result*, not in `actions`. An action is routed through the node's cell actor, which serializes - the right guarantee for a state update, the wrong one here, because routing every dispatch in the app through one actor reintroduces the head-of-line blocking the bus does not otherwise have. An action also hands back a Promise or an Effect that every call site would have to discard. A method on the result is a plain closure over `ctx.signals.publish`: no actor to enter, nothing to await.

Analytics dispatch is fire-and-forget, so the method returns `void`. Use an async-mode node for it - there `ctx.signals.publish` returns `Promise<void>` and the method can drop the promise, where in effect mode it would have to run the Effect itself.

Dropping it means catching it rather than voiding it. Publish is admitted as runtime work, so it rejects with `FrondRuntimeClosed` once the runtime is stopped, and a dispatch racing teardown is exactly when that happens. An empty catch is right here specifically because the method is fire-and-forget: the caller was never told whether delivery happened, and analytics is the last subsystem that should take an app down on its way out.

```ts
import * as Frond from "@frondruntime/core";

// Exported: features extend it by declaration merging (below).
export interface AppEvents {
  "app.opened": void;
  "cta.clicked": { readonly cta: string };
}

// NOT exported. The only way to build a signal on this channel is `track`.
const Analytics = Frond.Signals.defineChannel<AppEvents>({
  name: "app.analytics",
  policy: { retention: "bounded", bufferSize: 256 },
});

interface Envelope {
  sessionId: string;
  screen: string;
  userId: string | null;
}

class Dispatcher {
  constructor(
    private readonly publish: (signal: Frond.Signals.RuntimeSignal) => Promise<void>,
    private readonly envelope: Envelope
  ) {}

  track = <K extends keyof AppEvents & string>(
    name: K,
    ...args: Frond.Signals.SignalPayloadArgs<AppEvents[K]>
  ): void => {
    const [payload, metadata] = args;

    this.publish(
      Frond.Signals.signal({
        channel: Analytics.channel,
        name,
        payload,
        metadata: { ...this.envelope, ...metadata },
      })
    ).catch(() => {
      // Publishing to a stopped runtime rejects. Analytics is the last thing
      // that should take an app down on its way out.
    });
  };

  screen(name: string): void {
    this.envelope.screen = name;
  }
}

type DispatcherSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: Dispatcher;
}>;

export class AnalyticsDispatcherNode extends Frond.NodeBase<DispatcherSpec> {
  static readonly spec = Frond.serviceSpec.async<DispatcherSpec>({
    tag: Frond.tag("app/analytics-dispatcher"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(
      async (ctx) =>
        new Dispatcher((signal) => ctx.signals.publish(signal), {
          sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          screen: "boot",
          userId: null,
        })
    ),
  });
}
```

The session id is minted from `Date.now` and `Math.random` rather than `crypto.randomUUID`, for the same reason the devtools client stopped calling it: React Native has no global `crypto` until a polyfill installs one, and a session id needs to be unique within a process rather than unguessable.

The generic keeps the full per-name typing the channel has: `track("cta.clicked", { cta: "buy" })` is checked exactly as `Analytics.signal` would check it. An undeclared name, a wrong payload, a payload passed to an event declared `void`, and an omitted required payload are each a compile error through this path.

No cast is needed inside, because `Signals.signal({ channel, name, payload, metadata })` declares `payload: unknown`. The other spelling does not work and is worth naming so nobody rediscovers it: destructuring `...args` and reassembling the call as `Analytics.signal(name, payload, metadata)` fails with TS2345, because the conditional tuple `SignalPayloadArgs<AppEvents[K]>` cannot be rebuilt from its own destructured elements while `K` is still generic. The object form sidesteps the rebuild entirely.

Two things this shape buys, both measured. Dispatch does not wait on delivery: three dispatches returned in 1ms against a subscriber taking 100ms per event. And the envelope is live rather than captured per call: one event carried `screen: "boot"`, `screen("cart")` was then called, and the next two carried `screen: "cart"` - in the subscriber and in the retained buffer alike.

The cost is cold start, and it is the honest one to state: `useNode` suspends, so a component cannot dispatch until the dispatcher node is acquired, and the events most at risk of being lost that way are precisely the cold-start ones. `Preload` the dispatcher at the app root, above anything that fires:

```tsx
<FrondReact.Preload nodes={[{ analytics: [AnalyticsDispatcherNode, {}] }]}>
  <Routes />
</FrondReact.Preload>;

// Anywhere below it, with no suspense left to pay:
const analytics = FrondReact.useNode(AnalyticsDispatcherNode, {}).result;

<button type="button" onClick={() => analytics.track("cta.clicked", { cta: "buy" })}>
  Buy
</button>;
```

What it is not is a re-render risk. `_result` is `observable.ref` and the envelope mutates inside a stable `Dispatcher` instance, so a dispatch-only component does not re-render when the envelope changes. The flip side is the rule that follows from it: do not render from the envelope, because nothing will tell React it moved.

"One way to dispatch" is enforced as a module boundary, not as a type. The channel constant stays unexported, so no other module can call `Analytics.signal` at all; the event map interface stays exported, because declaration merging needs it, so features keep contributing events without gaining a way to publish them. Other nodes reach the same method through a declared dependency - `ctx.deps.analytics.result.track(...)` - which is the ordinary dependency path, not a second door.

That merged map is what makes one app-wide channel workable. A feature module extends the shared interface where its own events live:

```ts
// features/cart/events.ts
declare module "../../analytics/dispatcher" {
  interface AppEvents {
    "cart.item.added": { readonly sku: string; readonly quantity: number };
  }
}
```

The channel constant is created before those augmentations are loaded and still sees every one of them, because merging is a type-level operation and `defineChannel` carries no per-event runtime artifact. The safety net is on the subscriber side: a handler whose `default:` branch does `const unhandled: never = record.signal` stops compiling the moment any feature adds an event, so a shared map cannot quietly grow past the code that handles it.

### Retention is also the privacy lever

A channel's `policy` decides what is kept. `bounded` retains the last `bufferSize` records (128 when omitted), readable through `ctx.signals.readRetained` and visible in the devtools feed. `none` retains nothing - and strips `payload` from the emitted runtime event and from sink delivery too, not only from the buffer. So a channel carrying anything that should not leave the process is declared `retention: "none"`: its payloads reach no devtools wire, while its channel and name still do, which is enough to see that it fired.

What `bounded` retains is the payload *by reference*: the record is pushed as published, with no clone and no freeze. So a payload you keep mutating shows up in devtools in whatever state it has reached by the time the feed is read, not the state it had at publish, and a live object stays pinned by the buffer for the next `bufferSize` publications on that channel. Publish flat facts - ids and scalars - rather than handing the bus an object the app goes on editing.

### Not a graph dependency

Signals do not participate in readiness. Nothing waits on one, delivery is best-effort, and a node that acquires after a signal fired sees no replay unless it asks for one (`ctx.signals.readRetained`), so a node result derived from delivery would differ by boot order. Dependencies stay declared through `dependencies`/`dep`; a signal that must change graph state does it by invoking an action, as above.

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
