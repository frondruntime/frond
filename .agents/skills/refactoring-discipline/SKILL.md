---
name: refactoring-discipline
description: Use when intentionally restructuring, splitting, renaming, replacing, or reducing complexity in this repo, especially when choosing a clean single path over compatibility, stale aliases, or parallel implementations.
---

# Refactoring Discipline

Use this skill for authorized restructure and replacement work in this repo. Prefer clean one-way changes over compatibility-preserving migrations unless downstream compatibility is an explicit requirement.

For package boundaries and public export shape, also use `monorepo-maintenance`. For tests, also use `testing-patterns`. After substantial edits, use `cleanup-audit` as a finishing pass to remove confirmed non-behavioral leftovers and report risky compatibility cleanup before changing it.

## Ground Rule

This repo optimizes for a clean golden path, not compatibility layers.

- Preserve Frond's design goal: make impossible or bad frontend runtime states unrepresentable where possible, runtime-guarded where necessary, and explicit where product code must choose.
- Prefer replacing bad or obsolete structure over preserving it.
- During an authorized refactor/replacement, delete stale aliases, compatibility exports, comments, tests, docs, and duplicate paths when the new boundary supersedes them.
- Preserve behavior only when that behavior is still part of the intended model.
- If current behavior is accidental or transitional, improve it directly and say what changed.
- Do not solve ownership drift by adding adapter shims. Move the mutation or lifecycle transition back to its named owner.
- When replacing runtime code, preserve the public DX intent, the ownership boundary, and the concurrency/error contract. Internals can break; impossible states and hidden races cannot be reintroduced.

## Workflow

1. Identify the intended model, not just the current behavior.
2. Search current callers and tests so the blast radius is known.
3. Choose the clean target shape before patching.
4. Replace in one coherent direction; avoid old/new parallel paths.
5. Update tests to the intended behavior, or add tests for the new boundary when behavior matters.
6. Run the narrowest useful test/typecheck, then broader verification when public signatures changed.

## Scope Control

- It is fine to combine renames, moves, and behavior correction when they are all part of an authorized replacement of one bad model with one better model.
- Do not preserve obsolete APIs just because tests or local callers use them. Update the callers/tests.
- Do not add migration shims unless the user explicitly says back compatibility is required.
- Keep diffs reviewable: one conceptual replacement per pass is better than several unrelated cleanups.
- If the work reveals an unrelated design problem, report it or make it a separate pass.

## Good Targets

- duplicated protocol construction
- large modules with unrelated reasons to change
- hidden dependencies or ambient state
- ownership drift where React, MobX, runtime client, graph, node cell actor, node, or driver can mutate the same lifecycle state
- race-prone runtime behavior that relies on React/UI callers being careful instead of a named node operation policy
- operation queues that serialize work but fail to express whether requests should queue, join, coalesce, restart, or reject
- repeated validation/stringification inside domain code
- unclear names that force readers to inspect implementation
- tests that only assert legacy shape instead of intended behavior
- old aliases, stale barrels, and compatibility re-exports during authorized replacement work
- parallel implementations of the same concept

## Poor Targets

- style-only churn in unrelated files
- mechanical renames without a clearer model
- abstractions created for one caller
- preserving a second path "just in case"
- characterization tests that freeze known-bad transitional behavior

## Verification

- Prefer package-local tests while iterating.
- Run root typecheck when public signatures, package exports, schemas, or Effect requirements change.
- Use lint/format tooling for mechanical formatting; do not hand-normalize formatting across unrelated files.
- In the final report, say whether behavior was intentionally changed, which stale paths were removed, and what verification covered.
