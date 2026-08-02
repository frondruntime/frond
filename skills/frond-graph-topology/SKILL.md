---
name: frond-graph-topology
description: Use when deciding whether something becomes a Frond node, adding or removing graph vertices and dependency edges, reviewing graph shape, or modeling navigation and other imperative host capabilities as graph state.
---

# Frond Graph Topology

A node is expensive: a vertex, a lifecycle, an identity, a test surface, and a
package boundary. It must pay for itself. This skill decides what enters the
graph; the frond-node-authoring skill decides how it is written.

## What Earns A Node

A candidate earns a vertex when it owns at least one of:

- **A capability lifetime** — a connection, subscription, server, SDK session
  that must be acquired, shared, and released (a leaf node).
- **Domain state with graph identity** — state that consumers key, observe,
  and depend on across the app.
- **A coordination policy** — fan-out with explicit concurrency and failure
  semantics, admission-serialized commands, cross-node sequencing.
- **A readiness contract** — something downstream nodes genuinely wait on.

If it owns none of these, it is a plain function, a plain class, or a leaf
module — not a node.

## Forbidden Vertices

**Alias / port nodes.** A node whose actions are 1:1 renames of one
dependency's actions and whose result mirrors that dependency's fields adds a
vertex, a package, and a test suite in exchange for a vocabulary preference —
and it usually ships a staleness bug for free. Consumers depend on the real
node. If a name genuinely helps, rename at the import site or wrap in a plain
function.

```ts
// DON'T: a rename with a lifecycle.
acquire: Frond.Driver.Acquire((ctx) => ({
  status: ctx.deps.provider.result.status,     // stale the moment provider moves
})),
actions: {
  openChat: Frond.Driver.Action((ctx) => ctx.deps.provider.actions.show()),
}

// DO: no vertex. Consumers depend on the real node and read/call it directly;
// a name that helps is an import-site rename or a plain function.
const provider = useNode(SupportProviderNode, Frond.Args.none);
provider.actions.show();
```

Scope the ban precisely: forbidden is the node whose result and actions are a
*verbatim re-export* of one dependency with no owned state and no logic. A
node that owns a real handle across calls and translates wire failures into
its own typed dispositions is a leaf-shaped node earning its vertex — do not
flag it for its name.

**DI-point nodes.** A node inserted so something can be swapped later is
dependency injection cosplay. Swapping happens through spec overrides at the
composition root, not through permanent graph vertices.

**Test-seam nodes.** A node added to make another node testable. Stub the
real dependency instead (frond-node-testing).

**Single-call wrappers.** A node wrapping one function call it neither owns
nor coordinates.

A facade is legitimate only when it adds semantics the dependencies do not
have: a fan-out with a declared concurrency/failure policy, computed domain
state over several deps, a serialized command lane over concurrent sources.
"Shorter name" and "stable-looking surface" are not semantics.

## Staleness: Never Copy Dependency State At Acquire

`acquire` runs once per incarnation. Copying `ctx.deps.x.result.field` into
your own result freezes a snapshot that silently diverges — dependency result
changes do not re-run your acquire, and the runtime does not cascade refresh.

- Consumers who need a dependency's state read that dependency.
- A node that must project dependency state does it at read time (computed
  getters over its own observed state) or through a refresh it owns
  deliberately (`ctx.refreshDep` is for a parent intentionally refreshing a
  direct dependency, nothing else).
- This rule is about *dependency* state. A node keeping two differently
  shaped views of its **own** state for different readers (a small observable
  projection for UI, a large plain buffer for tooling) is a deliberate
  reader split, not a staleness bug.

## Edges

- Semantic nodes depend **directly** on the transport/service node they use.
  No intermediate layer nodes between a domain node and its transport.
- Dependencies are declared in `Frond.dependencies(...)` and consumed through
  `ctx.deps`. A dependency smuggled through a driver-factory option, module
  import of another node's result, or ambient lookup is a hidden edge and a
  future incident.
- Node-to-node edges are Frond graph edges. Effect services/layers are for
  runtime and driver plumbing — never a replacement for keyed node identity.
- Recovery flows through re-acquisition, not interception. When an upstream
  fact changes (a session expires, a credential rotates), the owning node
  commits the new fact and dependents re-acquire against it. Do not build
  retry/refresh interceptors inside capability objects to paper over what a
  graph edge already models.
- Keying: `Key.singleton()` unless consumers genuinely address instances by
  args; then `Key.structure(...)` over the minimal canonical shape. Never
  encode environment or platform into keys that a spec override should decide.
- Tags name the domain (`app/orders`, `app/session`), nothing else. Keep
  organization names, product branding, and legacy system identifiers out of
  tags, node IDs, and diagnostics.

## Imperative Host Capabilities: Intent Dispatch

Navigation, toasts, dialogs, and other capabilities born inside the UI tree
are part of the graph as **state**, not as bound ports.

Golden path — the node stays sealed and exposes intent:

- The node's result carries pending intents (a queue or current command) plus
  whatever settled state the domain needs (current route, dismissed ids).
  Intents carry a monotonic sequence id; `acknowledge(id)` removes exactly
  that intent and commits only when something changed.
- If the pending queue is bounded, the cap and its overflow behavior are
  documented on the contract — silent truncation quietly breaks the
  delivery guarantee under load.
- Producers dispatch through normal actions (`navigate`, `show`).
- One bridge component at the composition root — the only imperative consumer
  — observes pending intents, executes them against the host capability it
  owns, and acknowledges through an action. Delivery is at-least-once: an
  intent stays pending until acknowledged, so a bridge remount may re-see
  it — id-based deduplication in the bridge makes that harmless.
- Whether a producer awaits the acknowledgment or fires-and-forgets is a
  per-case contract; encode it in the action's output type, not in global
  policy.

Migration-only shape: bind/unbind host registration on a node (binding
tokens, `WithInternal` host slots). Acceptable while porting a legacy host
layer; never for new design. New code inverts it: the graph never learns the
host object exists.

## Where Non-Node Code Lives

- Pure logic: plain functions next to their node, or a shared package.
- Ambient reads: leaf modules with exactly one owning node
  (frond-node-authoring).
- Shared cross-cutting policy (resilience containment, scrubbing): one shared
  helper package, consumed inside drivers — not a node, not a base class.

## Keep The Topology Honest

Maintain one hand-written inventory per application: canonical tags and
dependency edges, asserted by a whole-graph acceptance test (see
frond-node-testing). Every vertex or edge change is a reviewed diff of that
inventory. If explaining why a vertex exists takes more than one sentence of
domain semantics, it does not belong in the graph.

For repositories with strict boundaries, add an import matrix — a literal
caller → may-import / must-not-import table next to the code — and a boundary
check script that enforces it file-by-file. Judgment calls scale badly;
allowlists do not.

## Checks

```sh
rg -B2 -A6 "Driver\.Acquire" src | rg "deps\.\w+\.result\."   # snapshot-at-acquire
rg "Driver\.Action\(\(ctx[^)]*\) =>\s*ctx\.deps\.\w+\.actions\." src   # 1:1 renames
rg "bindHost|unbindHost|BindingToken" src   # migration-only shapes in new code
```

---

Describes: @frondruntime/core 0.4 (checked against .release-please-manifest.json by `bun run skills:check`)
