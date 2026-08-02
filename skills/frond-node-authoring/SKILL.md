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
  readonly result: OrdersResult;
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
      return new OrdersResult(orders);
    }),
    actions: {
      placeOrder: Frond.Driver.Action(async (ctx, input) => {
        const order = await ctx.deps.transport.client.orders.place(input, ctx.signal);
        ctx.patchResult((draft) => draft.upsert(order));
        return order;
      }),
    },
  });
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
- Consumers call `node.actions.*`. Class methods exist only when they add real
  domain semantics — never as pass-through wrappers.

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
  security-relevant.
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

## Cancellation

- `ctx.signal` is the operation's signal; pass it to everything the hook or
  action awaits. `ctx.nodeSignal` is the node incarnation's signal; use it for
  long-lived SDK listeners. Never retain `ctx.signal` past the operation.
- Abort stays cancellation. Never translate it into a domain failure, and
  never hand-roll `throwIfAborted` / `isAbortError` / synthetic `AbortError`
  plumbing — the runtime owns that.
- Actions take options where the contract needs them:
  `Frond.Driver.Action(run, { timeout: 5_000 })` or `timeout: "unbounded"`
  (skips only the deadline — stop, eviction, and caller interruption still
  interrupt), and `admission: "join"` when equal inputs should share one
  in-flight run. The default admission queues per node.

## The Only Injection Seams

Graph dependencies and spec overrides. Nothing else.

- A driver factory (`create*Driver(options)`) may exist only when production
  code passes non-default options: a platform file-resolution split
  (`.native.ts` / `.web.ts`) or a composition-root injection the app really
  performs. If only tests would pass options, delete the factory and stub the
  dependency instead (see the frond-node-testing skill).
- `spec.fromDriver` / `Frond.specWithDriver` exist for exactly those cases and
  for intentionally shared pre-built drivers. Never inline-extract a driver
  just to name it.
- A `NodeDescriptor<Spec, mode>["driver"]` type alias in a node file is a
  symptom: the driver left the spec without one of the two reasons above.
- If a hook needs outside-world state, either depend on the node that owns it
  or become a leaf that owns it. A "host" object handed in through factory
  options is a dependency hiding from the graph.

## Resilient External Integrations

A leaf node wrapping a non-critical external capability (analytics, tracking,
attribution, third-party widgets) must degrade instead of blocking the graph:

- Ordinary startup failure stays an ordinary failure of the leaf, contained
  behind an internal deadline well under the runtime driver timeout.
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

## Avoid

- Mode-less spec shapes and nested `driver:` fields in authored specs (pre-0.2).
- Generated-superclass authoring, standalone spec consts, ready-node aliases.
- Custom node base classes, package-local spec factory wrappers, re-export
  shims over `@frondruntime/core`.
- Test-only options parameters, `createHost`-style factory chains, DI-point
  indirection of any shape.
- Hand-rolled abort plumbing.
- Pass-through class methods over `this.actions.*` / `this.result.*`.
- Local queues, timeout races, or result wrappers around the action lane.
- Copying a dependency's result fields into your own result during `acquire`
  (see frond-graph-topology: staleness).
- Separate `XDeps` / `XActions` / `XDriverContext` aliases that mirror one
  node's carrier.

## Checks

```sh
rg "NodeDescriptor<[^>]+>\['driver'\]" src
rg "export function create\w+(Driver|Host)\(" src
rg "throwIfAborted|isAbortFailure|new Error\(.*[Aa]borted" src
rg "signal: AbortSignal" src   # in result/service types: action lane rebuilt by hand
rg "driver: Frond\.Driver\.(Async|Effect)<" src   # nested driver outside fromDriver
```

Every hit needs one of the two sanctioned reasons or a fix. Run the package
typecheck after authoring; run broader checks when public typing changed.
