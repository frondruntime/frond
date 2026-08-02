---
name: frond-node-testing
description: Use when writing or reviewing tests for Frond nodes, drivers, actions, lifecycle, or graphs, including the test harness, spec overrides, mock factories, deterministic operation gates, and per-package testing exports.
---

# Frond Node Testing

Tests replace dependencies, never the node under test. The node must not know
it is being tested: no test-only constructor parameters, options, flags,
callbacks, or setters in production code. If a node is hard to test without
one, its dependencies are wrong — fix the graph, not the test.

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

## React

- `TestFrondProvider` from `@frondruntime/react/testing`; it owns a harness
  when none is passed.
- `useNode` / `useNodeState` assertions require an ErrorBoundary in the test
  tree; readiness errors are boundary errors, not rejected promises.
- Assert on node reads and events, not render counts.

## Avoid

- Overriding or mocking the node under test.
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
```
