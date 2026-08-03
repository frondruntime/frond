---
name: frond-review
description: Use when reviewing a diff, increment, or pull request in a Frond application - node authoring changes, graph shape changes, React consumption, or tests. The enforcement half of the official Frond skills; runs their checks and renders verdicts.
---

# Frond Review

The architecture is the mechanism. A side effect in React, a hidden edge, or
a test seam in production is the same class of defect as a corrupted result —
review them with the same severity, not as "style".

Verdict model: **deviation from the golden path is a blocker. Unsure is a
blocker until refuted.** The author refutes with evidence (source, a passing
check, a cited skill rule), not with intent.

## Scope First

1. List the changed files and classify each: node/driver, leaf module, graph
   wiring (deps/keys/tags), React, tests, bootstrap, other.
2. Load the matching official skills (frond-node-authoring,
   frond-graph-topology, frond-node-testing, frond-react, frond-debugging).
   Review against those files, not memory. If the repository ships a local
   supplement skill, load it too and run its checks under this verdict
   model — supplements tighten these gates, never loosen them.
3. Run every `Checks` block from the loaded skills and intersect the hits
   with the diff (`git diff --name-only <base>`). Every hit on a changed
   file is a finding until refuted.

## Two Sweeps

**Mistake sweep** — defects an author makes honestly:

- Dependency state copied into a result at acquire (staleness).
- A leaf capability whose release cannot be proven (lifetime handle not on
  the result; unbounded teardown; partial-acquire leak).
- `ctx.signal` retained past its operation; abort translated to a failure.
- A non-`observer` component reading observable getters.
- Result committed from an action return value instead of `ctx.setResult` /
  `ctx.patchResult`; class result patched without `resultPatch.nonPlainClone`.
- Live work whose `stop` does not dispose what `start` returned; liveness
  inferred from component presence.
- A stateful capability result mutating itself without `ctx.setResult` on
  observable transitions, with no action-only/non-reactive declaration.
- Tests asserting through React what the harness proves directly.

**Drift sweep** — patterns that erode boundaries gradually:

- A new vertex that is an alias, port, DI point, or test seam.
- A driver factory or options bag whose only caller is a test.
- A new `useEffect` doing domain work; a bridge component acquiring a second
  capability; imperative host objects reaching the graph.
- An effect-mode node without its confirmation comment above the spec
  (`// effect-mode: <reason> — confirmed <who/when>`).
- A new ambient touch outside a declared leaf; a leaf gaining a second
  capability; a leaf imported by a second module.
- Vocabulary or wrappers re-introducing a legacy shape (mode-less specs,
  nested `driver:` in authored specs, bind/unbind host ports in new code).
- A parallel idiom where a framework primitive exists: hand-rolled result
  capsules next to `withInternal`, manual signal joins next to
  `AbortSignal.any`, underscore-prefixed "internal" actions as access
  control.

## Per-Area Gates

- **New node**: one-sentence domain justification (topology); sealed or leaf
  declared; factory kind matches intent; key minimal and canonical; inventory
  test updated.
- **New edge**: consumer depends on the real owner, not a rename; no layer
  nodes between domain and transport.
- **Leaf change**: one capability, one owning node, header comment current,
  boundary check/allowlist updated in the same diff.
- **Action change**: contract output caller-facing only; admission/timeout
  options justified by the contract; cancellation passes `ctx.signal`.
- **React change**: reads via sanctioned hooks; `observer` where getters are
  read; failures split correctly between `operationFailure` and boundaries.
- **Test change**: node tested as a node; overrides replace direct deps only;
  no sleeps; `./testing` contract kept; mock factories still tested.
- **Release surface**: public API changes carry conventional-commit intent
  and skill updates in the same PR when they change the golden path.

## Findings Format

Each finding: `file:line` — the defect in one sentence — the skill rule it
violates (skill + section) — the minimal fix — verdict:

- **blocker** — golden-path deviation, boundary violation, or unproven
  lifecycle. Merges do not happen over blockers.
- **fix-before-merge** — correct shape, defective detail (missing check,
  stale comment, unproven edge case).
- **note** — improvement that does not gate.

Anything the review could not establish (an unverified claim, an unreadable
dependency, a check that could not run) is listed as **unknown — blocker
until resolved**. A clean review states what was swept and which checks ran,
not just "looks good".

---

Describes: @frondruntime/core 0.4 (checked against .release-please-manifest.json by `bun run skills:check`)
