---
name: agent-self-check
description: Use before finishing coding work or after deterministic check failures, including lint/typecheck/test loops, interpreting diagnostics as just-in-time prompts, and deciding whether repeated implementation mistakes should become stricter rules.
---

# Agent Self Check

Use this skill to close the write-check-fix loop. Deterministic diagnostics are stronger than prompt instructions.

## Core Rule

Treat lint, type, language-service, and test failures as prompts attached to exact code locations. Fix the root cause, then re-run the narrowest check that can prove it.

## Workflow

1. Run the narrowest relevant check after source edits.
2. Read diagnostics literally: file, span, rule, message, expected fix.
3. Load any skill named by the diagnostic message.
4. Fix the source pattern, not only the immediate line.
5. Re-run the failed check.
6. Self-review the changed code for generated-code leftovers and weak modeling.
7. If the same class of mistake appears repeatedly, ask whether it can be caught deterministically.

## Mandatory Self-Review

Before finalizing code changes, inspect the diff as if reviewing another agent's work.

These checks have higher authority than "tests passed." Passing tests do not make weak modeling, stale compatibility artifacts, or silent fallbacks acceptable.

Fix these directly when they are in your changed code. If fixing one would change public behavior, package exports, persisted data handling, or compatibility, stop and report it as a deferred concern instead of silently preserving or deleting it.

For each issue you find, name the mechanism before fixing it. Do not patch symptoms by adding local conditionals, broad fallbacks, or compatibility wrappers unless that is the intended design.

### Modeling

- closed protocol/domain/state handling written as if/else return soup instead of exhaustive `Match` or `switch` with a `never` check
- boolean matrices where a discriminated union or explicit state machine would make the state space clear
- correlated optional fields that permit illegal states
- unsupported internal variants hidden behind fallback/default branches instead of failing loudly
- repeated exported `_tag` object literals that should use named constructors
- raw `string` IDs crossing package, persistence, tool, RPC, dispatch, or mission boundaries where a branded/schema-backed ID is expected
- closed sets widened to `string` when runtime extension is not intended
- ordering hidden in object key order, import order, registration order, or incidental array order instead of encoded in the API

### Boundaries

- optional/default soup: scattered `options?.x`, `x ?? fallback`, conditional object spreads, or defaults repeated inside function bodies instead of one boundary normalizer
- broad `Record<string, unknown>` values flowing past ingress without schema decoding or an explicit extension point
- external/provider shapes leaking into core/domain contracts without being deliberately promoted
- repeated partial adapters where data is half-normalized across several layers instead of translated once at the boundary
- expected external uncertainty collapsed into generic defects instead of typed recoverable failures
- internal invariant violations hidden behind generic errors, silent drops, or best-effort recovery

### Effect And Runtime

- constructors/builders that perform I/O, allocate runtime resources, read config, call providers, or start fibers
- runtime services, clocks, random/id generation, stores, language models, or mutable context accessed ambiently instead of from the Effect environment at execution time
- expected failures thrown or defected instead of kept in the Effect error channel
- `Effect.runPromise` / `Effect.runSync` used inside services or domain functions instead of at process/test boundaries

### Structure

- large mixed modules, stale aliases, compatibility wrappers, empty stubs, or old/new parallel paths left by the change
- public barrels containing runtime behavior instead of public surface
- `utils.ts`, `helpers.ts`, `common.ts`, giant `types.ts`, or miscellaneous service bags introduced or expanded
- speculative abstractions with no real boundary, domain concept, or repeated use
- package-boundary imports that point upward into a higher-level package

### Tests

- missing focused tests for new runtime behavior, service behavior, boundary translation, constructors with defaults, or changed protocol variants
- broad runtime/server/web E2E tests added where an isolated service/layer test would prove the behavior
- characterization tests that freeze known-bad transitional behavior instead of intended behavior

### Cleanup And Docs

- generated `dist/` or build output hand-edited instead of source
- docs changed under `docs/` without respecting vault structure, note ownership, links, and archive rules
- stale comments, TODOs, old names, or compatibility notes left by the change

Do not preserve weak code because checks pass. Do not add TODO decorations for obvious gaps; either fix them or report the explicit deferral.

## Rule Escalation

Consider adding or tightening a rule when:

- the bad pattern is syntactically recognizable
- the desired fix is deterministic or explainable in one diagnostic
- false positives are expected to be low
- the mistake is repeated, high-risk, or caused by stale model training data
- the rule would save future contributors from relearning the same correction

For Biome/Grit rules, use `biome-grit-rules`.

## Severity

- `error` - project invariant, stale API, unsafe pattern, or known agent trap.
- `warning` - style preference, migration aid, or pattern with valid exceptions.
- do not add a rule when the decision needs semantic judgment the checker cannot prove.

## Final Check

Before final response:

- report which checks ran
- report failures that remain and why
- do not claim a check passed unless it was run after the final relevant edit
- report any self-review concerns you intentionally deferred
- mention if no self-review concerns remain after your cleanup pass
