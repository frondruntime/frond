---
name: code-review
description: Use when reviewing code changes in Frond, especially to find defects, behavioral regressions, missing tests, weak type modeling, stale compatibility leftovers, and agent-generated implementation artifacts.
---

# Code Review

Use this skill for review-only passes and PR-style feedback. Lead with findings.

## Review Stance

Prioritize:

- defects
- behavioral regressions
- missing tests
- public contract or package-boundary risks
- weak modeling that will make future defects likely
- stale leftovers from refactors or long agent sessions

Do not rewrite code during a review unless the user asks for fixes. If you find cleanup that may break compatibility or public behavior, report it as a concern.

Treat the checklist below as review gates, not taste notes. If changed code violates one, either file a finding or explicitly explain why the local context makes it acceptable.

Review diagnosis must identify the mechanism, not just the symptom. Prefer:

- observation: what the diff/code/test shows
- inference: what mechanism likely produced it
- prescription: what change removes the mechanism
- measurement: what check proves the fix

For recurring problems, use the frame: signal, loop, constraint, intervention, measurement.

## Finding Format

For each finding, include:

- priority: `P0`, `P1`, `P2`, or `P3`
- confidence: `C0`, `C1`, `C2`, or `C3`
- tight file/line reference
- observation: the concrete evidence
- mechanism: why it creates risk
- prescription: what should change
- measurement: what would verify the fix

Order findings by severity. Keep summaries secondary.

## Modeling Review

Call out these patterns when they appear in changed code:

- frontend runtime hazards pushed to component discipline instead of represented by a Frond contract
- races hidden by UI button disabling when runtime callers can still submit the operation
- operation scheduling intent left implicit where requests could reasonably be queued, joined, coalesced to latest, restarted, or rejected while busy
- stale commit paths that do not prove they still own the current node generation after interruption, eviction, args changes, or supersession
- driver operations that register disposers but do not define the ownership transfer on success, failure, and interrupt
- ready-data invalidation paths that close or replace the node without running the full live stop, release, disposer, and close sequence
- interrupted acquire, refresh, action, or live-start work that does not abort the driver-facing signal
- closed protocol/domain/state handling implemented as if/else return soup instead of exhaustive `Match` or `switch` with a `never` check
- fallback/default branches that hide unsupported internal variants
- boolean matrices that should be discriminated unions or explicit state machines
- correlated optional fields that permit illegal states
- raw `string` IDs crossing package, persistence, tool, RPC, dispatch, or mission boundaries
- closed sets widened to `string` when runtime extension is not intended
- repeated exported `_tag` object literals that should be named constructors
- public protocol call sites using `as const` where a typed constructor would make intent clearer
- `Record<string, unknown>` flowing past ingress without schema decoding or a named extension point
- provider-specific shapes leaking into core/domain contracts
- ordering that depends on incidental object key order, import order, registration order, or array order
- public primitive API names that repeat the namespace instead of reading clearly under it
- generic parameter order that drifts from input, output, error, requirements for tool-like APIs

## Boundary Review

Check that:

- changed behavior advances the Frond runtime direction documented in `AGENTS.md`, package READMEs, public docs, and current tests:
  impossible states become unrepresentable, runtime-guarded, or explicitly contracted
- changed state has exactly one owner named in migrated ownership-boundary docs
- graph/runtime owns node construction, runtime slot hydration, readiness clearing, attempts, release, eviction, graph lifecycle, and liveness demand records
- node owns MobX domain state, computed getters, domain methods, and observation-derived liveness signals
- MobX and React adapters mirror, translate, subscribe, and schedule through handles only; they do not hydrate nodes, clear runtime slots, own readiness, or become liveness truth
- `Ready` never means "adapter still has to hydrate"; ready runtime reads expose consumer-ready graph-owned nodes
- adapter-facing reads remain observational: no scheduling, graph mutation, lifecycle events, or raw slot errors
- liveness paths that can affect driver work are serialized through the node cell actor
- external inputs are decoded and normalized once at the boundary
- internal code receives explicit required data instead of optional/default soup
- defaults do not creep through multiple layers after boundary normalization
- absence is not used as an implicit state when an explicit sentinel/domain variant would make semantics clear
- expected external uncertainty is typed and recoverable
- violated internal contracts fail loudly instead of becoming generic fallback behavior
- expected failures stay in the Effect error channel instead of becoming thrown exceptions or defects
- constructors/builders shape values only; they do not perform I/O, allocate resources, read config, call providers, or start fibers
- runtime services, clocks, random/id generation, stores, language models, and mutable context come from the Effect environment at execution time
- runtime data crossing process, tool, dispatch, RPC, or persistence boundaries stays serializable

## Structure Review

Call out:

- large files that mix protocol types, service tags, implementation, persistence, serialization, command routing, and tests
- `utils.ts`, `helpers.ts`, `common.ts`, giant `types.ts`, or miscellaneous service bags
- stale aliases, compatibility wrappers, empty stubs, old/new parallel paths, and accidental re-export layers
- public barrels containing runtime behavior instead of public surface
- speculative abstractions with no real boundary, domain concept, or repeated use
- package imports that point upward into a higher-level package
- provider-specific code placed outside provider adapters
- React imports or adapter imports inside runtime, graph, driver, node, or keys
- direct `_hydrateRuntime(...)` or `_clearRuntimeReadiness()` calls outside graph lifecycle code and node implementation
- generated `dist/` or build output edited by hand
- comments explaining temporary compatibility or legacy behavior with no explicit accepted follow-up

## Test Review

Missing tests are findings, not TODO decorations.

Look for missing focused tests around:

- new runtime behavior
- isolated runtime behavior owners with fake Effect layers/services
- service behavior: registries, stores, parsers, dispatch loops, satellite rings, tool execution boundaries
- protocol constructors that normalize defaults or enforce invariants
- boundary adapters that translate external/provider data
- error-channel behavior and defect behavior
- cross-package signature or package-export changes
- package-local assembly where behavior crosses a few services

Do not ask for broad runtime/server/web E2E tests unless the change is specifically about wiring, transport, or end-to-end assembly.
Call out broad E2E tests used as the first proof for behavior with a clear isolated owner.

## Error Review

Call out:

- expected domain failures modeled as defects or generic errors
- defects recovered as if they were normal external uncertainty
- generic error bags where a narrow tagged error should name the failed invariant or external operation
- fallback/default branches that silently drop, ignore, or "best effort" internal protocol violations
- foreign errors converted without stable context, or with secrets/large payloads leaked into diagnostics

## Cleanup Review

For substantial edits, also load `cleanup-audit`.

Separate:

- `Removed`: cleanup that is proven non-behavioral
- `Concerns`: stale paths or compatibility artifacts that need confirmation before removal

Back compatibility removal is not cleanup unless the user explicitly authorized it.

## Documentation Review

For docs changes under `docs/`, first inspect the local docs layout.

Call out:

- docs treated like a generated site instead of the repo's docs vault
- current design guidance buried in dated notes or drafts
- superseded design material deleted instead of archived when it has future value
- stale links, stale section indexes, or moved notes without navigation updates
- relative Markdown link rules or local docs conventions violated
