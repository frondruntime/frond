---
name: frond-architecture-review
description: Use when reviewing or improving Frond architecture, finding deep refactor candidates, designing runtime/module ownership changes, or deciding whether an Effect-powered runtime concept should be deepened, split, deleted, or documented.
---

# Frond Architecture Review

Use this skill for architecture review, refactor discovery, and design review in Frond. The goal is not generic cleanup. The goal is to find places where Frond's runtime contract is shallow, duplicated, ownerless, or easy for frontend code to misuse.

For implementation work after a candidate is chosen, also use `refactoring-discipline`, `monorepo-maintenance`, `typescript-strict`, and the relevant Effect skill.

## Required Reading

Before reviewing runtime, graph, node, driver, MobX, React adapter, liveness, lifecycle, operation, error, snapshot, or public contract changes, read:

- this repository's `AGENTS.md`
- the nearest package README and public docs page for the area under review

Then read only the local source and tests that match the topic.

## Vocabulary

Use Frond's stable terms from `AGENTS.md`, package READMEs, public docs, and current code.
Verify terms against code and do not introduce synonyms.

Architecture comments should name:

- the **owner** of a state transition or scheduling decision
- the **contract** callers rely on
- the **runtime hazard** being prevented
- the **Effect boundary** where failure, scope, service requirements, interruption, or resource lifetime is represented
- the **test surface** that proves the contract

Use `seam` only when discussing an explicit extension point or adapter boundary. Do not use it as a substitute for Frond's ownership boundary vocabulary.

## Review Process

1. Identify the intended model from docs before judging the current code.
2. Search the current implementation and tests with `rg`; do not infer file shape or API names.
3. Trace ownership for the relevant state: runtime host, graph system, node cell actor, node, driver, runtime client, MobX view, React adapter, sink/devtools, or signal subscriber.
4. Trace the Effect boundary: what succeeds, what can fail, what services are required, what scope owns resources, what can be interrupted, and what commits after interruption.
5. Find shallow or leaky modules by applying the deletion test: if the module disappeared, would its complexity vanish, or would callers reimplement its invariants, ordering, failure handling, and lifecycle rules?
6. Separate candidates from solutions. Present architecture candidates first; design concrete interfaces only after the user chooses one.

Do not require subagents. If the user explicitly asks for parallel exploration and the current mode permits it, split independent areas by ownership or package; otherwise do the review locally.

## Candidate Signals

Strong architecture candidates usually show one of these mechanisms:

- two owners can mutate the same runtime fact
- a read path schedules work, mutates graph state, hydrates nodes, or emits lifecycle events
- React, MobX, devtools, or tests complete runtime work that graph/runtime claimed was complete
- a UI safeguard substitutes for a runtime contract
- operation admission is implicit where calls could queue, join, reject, restart, or coalesce
- stale commits can mutate state after interruption, eviction, args supersession, release, or newer attempts
- Effect failures, defects, services, scopes, or interruption are erased at an internal boundary
- provided invalid protocol/config values are silently coerced instead of failing at the boundary
- `Record<string, unknown>`, raw strings, correlated optional fields, or boolean matrices cross runtime boundaries
- Effect service dependency injection is mixed with Frond node spec overrides
- runtime/graph/driver/node/keys import React, MobX adapter code, DOM, devtools transport, or provider-specific code
- tests exercise internals because the public contract is too weak to prove behavior
- compatibility aliases preserve obsolete lifecycle or concurrency concepts without an active design note

Reject candidates that are only style churn, one-caller abstractions, speculative extension points, or file splitting that separates code that must always be read together.

## Candidate Output

Present a numbered list. For each candidate include:

- **Files**: tight file references.
- **Observation**: what the code/docs/tests show.
- **Mechanism**: why this creates architectural friction or runtime risk.
- **Prescription**: the direction of the fix in plain English, not a full interface design.
- **Measurement**: the focused test, typecheck, diagnostic, or doc update that would prove the fix.
- **Design rule**: which Frond doc rule supports or conflicts with the prescription.

Mark uncertainty directly. If a candidate depends on an assumption, state the evidence that would confirm or reject it.

Do not propose concrete new public APIs in the first pass unless the user asked for API design. Ask which candidate to explore.

## Design Review

When the user chooses a candidate, walk the design tree before editing:

1. Name the impossible or bad frontend state the change prevents.
2. Name the single owner of the state transition and the single owner of scheduling.
3. Decide what remains pure and what belongs in Effect.
4. Specify expected failures versus defects.
5. Specify resource scope, interruption behavior, cancellation reason, and stale-commit guard.
6. Decide whether the interface should be runtime public, graph internal, node authoring, driver authoring, adapter-facing, or test-only.
7. Define the test surface through the contract, not through internals.
8. Identify docs that must change because the design rule changed.

If the design contradicts an active rule, stop and say so. Continue only if the user explicitly wants to revise that rule.

## Effect Gates

Use the narrower Effect skills when relevant:

- `effect-concurrency-lifecycle` for fibers, queues, scopes, interruption, liveness, cancellation, and background loops.
- `effect-services-layers` for services, layers, runtime dependencies, and test layers.
- `effect-errors-schema` for typed failures, defects, schemas, and boundary decoding.
- `effect-observability-time` for clocks, duration, retry, timeout, logging, tracing, metrics, config, and redaction.
- `effect-testing-runtime` for deterministic Effect tests and runtime verification.

Architecture is not ready when Effect details are hidden behind Promise-only signatures, erased errors, unscoped resources, unbounded concurrency, or callback mutation that bypasses the node cell actor.

## Decision Records

Do not create generic ADR machinery. Prefer updating the nearest public docs or package README.

Offer a new or updated design note only when all are true:

- the decision changes ownership, lifecycle, concurrency, public contract, package boundary, or Effect runtime topology
- a future reviewer would reasonably re-suggest the rejected alternative
- the reason is not already recorded in `AGENTS.md`, package READMEs, public docs, or tests

Prefer updating the nearest public design note over creating a new note.

## Watch-Out

A good Frond architecture refactor removes caller discipline. If the proposed fix says "components should be careful," it is not a runtime architecture fix.
