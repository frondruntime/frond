---
name: frond-react
description: Use when consuming Frond nodes from React with @frondruntime/react, bootstrapping a runtime for a React app, wiring providers, Suspense, error boundaries, bridge components, or deciding what state belongs in the graph versus local component state.
---

# Frond React

React is capability-poor. Components render node state and dispatch node
actions. Application authority — async work, side effects, external
capabilities, navigation decisions — lives in the graph.

## Hard Boundary

Components and hooks must not:

- run domain work in `useEffect` / `useLayoutEffect`;
- import `@frondruntime/core` runtime surfaces, `effect`, transports, leaf
  modules, or raw runtime event types;
- own readiness, retries, timeouts, or liveness (`useEffect`-mounted flags are
  not liveness);
- talk to anything the graph did not hand them.

The two sanctioned imperative places in a React tree are the composition root
(bootstrap) and bridge components (below). Everything else is render.

## Consumption

Default: Suspense-throwing reads plus MobX observation.

```tsx
import { observer } from "mobx-react-lite";
import { useNode } from "@frondruntime/react";

export const Orders = observer(function Orders(): React.ReactNode {
  const orders = useNode(OrdersNode, Frond.Args.none);
  return <List rows={orders.rows} onPlace={(input) => orders.actions.placeOrder(input)} />;
});
```

- `useNode` re-renders on graph-level changes only. Any component reading
  getters over observable state **must** be wrapped in `observer` — this is
  load-bearing, not optional.
- `useNodeState` when the UI needs `busy`, `operationFailure`, or
  `resultValidity`. Caller-visible operation failures surface as
  `operationFailure`; render-critical failures throw to the nearest
  ErrorBoundary. Never both for the same failure.
- `useNodes` for a composite unit that suspends as one; the key set must be
  stable. `Preload` for layered warm-up.
- `useNodeRead` is the explicit-state escape hatch — boot screens and
  no-boundary contexts that render every phase of the tagged read. Do not
  mix it with Suspense reads of the same node in one component.
- `useNodeControls` for ensure/refresh/evict without reading the result. It
  is not a liveness source.
- Every Suspense boundary has an ErrorBoundary; project boundary errors with
  `getErrorReport` and recover with `getErrorRecovery` — do not parse error
  strings.

## UI-Driven Nodes

A node whose actions are fired directly from event handlers is authored
`facadeSpec.async` — promises at the callsite, no Effect ceremony. Handlers
call `node.actions.x(input)`; whether a callsite awaits the promise or
fires-and-forgets is that interaction's contract. A dropped promise still
reports through runtime events; never add `.catch(() => {})` wrappers as a
reflex.

## Bridge Components

The one sanctioned side-effectful component shape: owned by the composition
root, it executes graph intents against a host capability born in the React
tree (navigation container, toast renderer) and acknowledges back through an
action.

```tsx
export const NavigationBridge = observer(function NavigationBridge(): null {
  const nav = useNode(NavigationNode, Frond.Args.none);
  const router = useRouter(); // the one host capability this bridge owns

  const intent = nav.pendingIntent;
  if (intent !== undefined) {
    void router.navigate(intent.target).then(
      () => nav.actions.acknowledge({ id: intent.id, outcome: "done" }),
      (error) => nav.actions.acknowledge({ id: intent.id, outcome: describe(error) })
    );
  }
  return null;
});
```

One bridge per capability; bridges render nothing; the graph never holds the
host object. See frond-graph-topology for the node side.

## Bootstrap (Composition Root)

- Create the runtime **once, outside React render**, synchronously:
  `Frond.createRuntime({ specOverrides, sinks, channels })`. Do not wrap it in
  a promise, a boot node, or a lease.
- HMR and tests replace runtime generations through
  `Frond.createRuntimeCoordinator()` — do not hand-roll generation tracking.
- Spec overrides at the composition root are the production injection seam:
  platform drivers, environment-specific integrations.
- Preheat the root before rendering gated trees:
  `runtime.client.node(RootNode, args).ensureReadyNode()` — a boot failure
  must be reportable before the UI owns the screen.
- Attach devtools here (`attachDevtools({ runtime, name })` from
  `@frondruntime/devtools`) and register sinks (telemetry) — never inside
  components.
- Mount `<FrondProvider runtime={runtime}>` once at the top. Nested providers
  are a design error.

## Graph State Vs Local State

Local component state is legitimate for ephemeral, render-scoped concerns:
input focus, hover, an editing flag, a wall-clock tick that would otherwise
emit runtime events forever. The test: would any other part of the app, or
any test, ever read it? Yes → graph. No → local. Forms live privately on the
node that submits them; React reads a closed presentation projection, never
the raw form.

## Avoid

- `useEffect` for anything the graph owns (fetching, subscriptions, retries,
  identity sync).
- Reading `Redacted`/sensitive values in components; unwrap only where the
  owning leaf does.
- Per-node wrapper hooks (`useXNode()`) that only alias `useNode(XNode, args)`.
- Package barrels that re-export `@frondruntime/react` verbatim.
- Passing node instances through props to hooks as a workaround — fix the
  observation problem instead.
- Conditional hook calls around Suspense reads; key sets that change shape.

## Checks

```sh
rg "useEffect\(" src/components src/surfaces   # each hit: render-scoped or a bridge?
rg "from ['\"]@frondruntime/core['\"]" src/components src/surfaces
rg "createRuntime\(" src --glob "!*composition*" --glob "!*bootstrap*"
rg "export function use\w+Node\(" src   # alias hooks
```

---

Describes: @frondruntime/core 0.3 (checked against .release-please-manifest.json by `bun run skills:check`)
