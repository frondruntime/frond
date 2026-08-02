---
name: frond-node-testing
description: Use when writing or reviewing tests for Frond nodes, drivers, actions, lifecycle, or graphs, including the test harness, spec overrides, mock factories, deterministic operation gates, and per-package testing exports.
---

# Frond Node Testing

Tests replace dependencies, never the node under test. The node must not know
it is being tested: no test-only constructor parameters, options, flags,
callbacks, or setters in production code. If a node is hard to test without
one, its dependencies are wrong — fix the graph, not the test.

## Test The Node As A Node

Node tests run on the harness and assert on reads, results, actions, and
events. They never mount React.

```tsx
// DON'T: the node "tested" through the whole pipeline. This proves nothing
// about the node that the harness would not prove, and re-tests the React
// adapter, which is not this repository's contract.
function Probe() {
  const orders = useNode(OrdersNode, Frond.Args.none);
  return <span>{orders.result.total}</span>;
}
render(<TestFrondProvider><Probe /></TestFrondProvider>);
expect(await screen.findByText("42")).toBeVisible();
```

```ts
// DO
const node = await harness.startNode(OrdersNode, Frond.Args.none);
expect(node.result.total).toBe(42);
```

The React adapter — `useNode` projecting node state into renders, Suspense
and boundary behavior — is `@frondruntime/react`'s own contract, proven in
that package's suite. A host application never re-proves it. React component
tests, including bridge components, are UI tests with UI tooling; they belong
to the app's UI suite and are not part of node coverage.

## Golden Path

```ts
import * as Frond from "@frondruntime/core";
import * as FrondTest from "@frondruntime/core/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.teardown();
  }
});

test("placing an order updates the result", async () => {
  const transport = createTransportStub();
  const harness = FrondTest.createFrondTestHarness({
    specOverrides: [transport.override],
  });
  harnesses.push(harness);

  const node = await harness.startNode(OrdersNode, Frond.Args.none);
  const order = await node.actions.placeOrder({ symbol: "X", amount: 1 });

  expect(order.id).toBeDefined();
  expect(node.result.byId(order.id)).toEqual(order);
  expect(transport.calls).toHaveLength(2); // list + place
});
```

- One harness per test, pushed to a local array, torn down in `afterEach`.
- `harness.startNode(Spec, args)` for the common ready path;
  `harness.node(Spec, args)` returns a handle when the test needs `read()`,
  `ensureReady()`, `refresh()`, or failure phases; `harness.readReady(handle)`
  / `harness.readError(handle)` project them with diagnostic messages.
- Assert on reads, results, and runtime events — never on render counts or
  internal fields.

## Override Tools — Pick By Intent

| Tool | Severs deps? | Use when |
|---|---|---|
| `FrondTest.readySpec(Node, result)` | yes | the dependency's value is all that matters |
| `FrondTest.mockSpec(Node, {...})` | no (unless resolver replaced) | dependency behavior matters, graph shape preserved |
| `Frond.specWithDriver(Node, driver)` | no | inject a full test driver, keep production wiring |

All three produce entries for `specOverrides`. Overrides replace the *direct
external dependency* of the node under test; downstream nodes always go
through overrides, never through module mocks.

## Vocabulary

- **fixture** — deterministic data (`createOrdersFixture()`), a plain function.
- **stub** — a dependency with deterministic behavior.
- **controller** — a stub that also records calls and exposes triggers
  (`emit`, `fail`, `complete`) for subscription lifecycles.
- **override** — the Frond wiring (`specOverrides` entry) that installs a stub.

Name helpers by what they are. A controller that only records is a stub;
a stub that carries assertions is a controller.

## The Per-Package Testing Contract

Every package that exports a node also exports `./testing` (from
`src/testing.ts`):

- One zero-arg-safe `createMockXNode(overrides)` factory per node, exposing
  result overrides and failure switches (`failOnAcquire`, `failOnAction`,
  `failOnRelease`) with recording.
- Fixtures for the node's result shapes.
- Production modules never import from any `./testing` path. Testing modules
  depend on production, never the reverse.
- The mock factory itself has tests: its failure switches and recordings are
  part of the package contract.

## Deterministic Operations — Never Sleep

- `FrondTest.createDeferredDriver()` gates operations explicitly:
  `waitForCall`, then resolve/reject exactly the call under test. Use it for
  admission, overlap, cancellation, and ordering tests.
- `harness.waitForEvent(predicate)`, `harness.waitForNodeRead(handle, predicate)`,
  and `harness.waitForIdle()` are the synchronization primitives.
- Arbitrary sleeps in a Frond test are a defect. A test that needs time uses
  a gate or an event predicate.
- Assert typed failures by `_tag`, never by stringified output.

## Runtime Defects Go Upstream

If a test isolates a defect in `@frondruntime/*` itself, reduce it to a
minimal reproduction against the published API and report it upstream. Never
patch, wrap, copy, or adapt runtime internals in application code — a local
workaround is a fork with extra steps.

## What To Test, By Archetype

**Sealed node.** The contract through its deps: acquire projection, each
action's caller-visible output and result commit, failure classification,
refresh semantics. All deps stubbed; no module mocks anywhere.

**Leaf node.** Everything a sealed node gets, plus the boundary: the owned
capability is released on evict/teardown (assert via the capability's own
observable effect, not internals), partial-acquire failure leaves nothing
behind, release survives a hanging capability (bounded), cancellation during
acquire never commits a result. Module mocks for the raw capability are
allowed **only** in this node's own test file — downstream tests use this
package's `./testing` export.

**Resilient integration leaf.** The shared containment matrix, proven once in
the shared helper's suite: success; ordinary failure → degraded; internal
deadline → degraded before the runtime timeout; cancellation never degrades;
reporter failure still commits; late settlement cleaned exactly once. Node
suites test only node-specific behavior plus an inventory test asserting the
node uses the shared path. Do not re-prove the generic matrix per node.

**Whole graph.** One acceptance suite per application boots the full canonical
graph against recorded/stubbed boundaries and diffs actual topology (tags,
dependency edges) against a hand-maintained inventory. Platform variants
assert topology parity. This is the test that catches alias nodes, orphaned
vertices, and accidental edges.

## If A UI Suite Needs A Runtime

Only UI suites (bridge components, composition-level screens) mount React —
and they are UI tests, not node tests. When one needs a runtime:
`TestFrondProvider` from `@frondruntime/react/testing` (it owns a harness when
none is passed), an ErrorBoundary in the tree because readiness errors are
boundary errors, and node state driven through the harness — never through
probe components written to expose node fields.

## Avoid

- Overriding or mocking the node under test.
- Mounting React to assert node behavior; probe components exposing node
  fields; asserting node results via rendered output.
- Test seams in production surfaces (options, flags, exported setters).
- `jest.mock` / `mock.module` for anything except the raw capability inside
  the owning leaf's own test file.
- Sleeps, retry loops, or polling without a bounded `waitFor*` primitive.
- Duplicating the shared resilience matrix in every node suite.
- Asserting on private fields, internal maps, or event counts that the
  contract does not promise.

## Checks

```sh
rg "setTimeout\(|sleep\(" --glob "*.test.*"
rg "mock\.module|jest\.mock" --glob "*.test.*"   # only inside the owning leaf's suite
rg "from ['\"].*\/testing['\"]" src --glob "!*test*" --glob "!*/testing.ts"
rg "useNode\(|TestFrondProvider|render\(" --glob "*Node.test.*"   # React in a node suite
```
