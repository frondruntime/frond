---
name: cleanup-audit
description: Use after substantial edits, refactors, moves, generated changes, or long sessions to find leftovers, stale stubs, unused imports, accidental compatibility artifacts, and scratch files. Remove only confirmed non-behavioral leftovers; report anything that may affect compatibility or runtime behavior before changing it.
---

# Cleanup Audit

Use this skill as a finishing pass after substantial work. This is a cleanup and review pass, not a refactor pass.

## Goal

Leave the repo without obvious generated-work leftovers:

- empty stubs
- unused imports
- stale comments
- accidental re-export wrappers
- old names in nearby docs or tests
- duplicate files created during moves
- scratch artifacts
- broad import artifacts introduced to avoid updating call sites

## Core Rule

Delete only when the artifact is proven unused, non-public, and non-behavioral.

If removal might change imports, package exports, runtime behavior, persisted data handling, public contracts, or downstream compatibility, stop and report it as a concern instead of deleting it.

## Not A Refactor

Do not use this skill to redesign code or remove live compatibility paths without confirmation.

- Cleanup removes confirmed trash.
- Refactoring changes structure or behavior.
- Compatibility removal is a breaking change unless the user explicitly authorized it.

When cleanup collides with compatibility, preserve behavior and report the stale path.

## Workflow

1. Inspect `git diff --stat` and changed files to understand the work surface.
2. Search old names, moved paths, and temporary terms with `rg`.
3. Check for empty files, stub files, and single-line re-export wrappers.
4. Check barrels and package exports for accidental old/new duplication.
5. Check imports for old paths, broad namespace artifacts, and unused leftovers.
6. Check tests, docs, and comments for stale names introduced by the change.
7. Remove only confirmed non-behavioral leftovers.
8. Report concerns separately from removed cleanup.

## Safe Cleanup Targets

Usually safe when verified unused:

- empty files that are not imported or exported
- unused imports
- scratch files produced by local experiments
- comments created by the current change that describe obsolete temporary state
- duplicate local helpers with no callers
- test fixture files with no imports and no package export path
- docs or comments that mention an old name where the new name is unambiguous

## Red Flags

Do not delete without confirmation:

- exported symbols
- package `exports`
- public barrels
- compatibility aliases or shims
- migration or fallback code
- persisted-data readers
- server, RPC, protocol, or serialized contract fields
- docs archive or design history
- files still imported anywhere
- behavior branches with active tests
- wrappers that may be used by downstream consumers

## Search Prompts

Use searches shaped by the actual change:

- old file stem, new file stem
- old exported names, new exported names
- `legacy`, `compat`, `deprecated`, `alias`, `old`, `v1`, `temporary`, `for now`, `TODO`
- removed path fragments
- package export paths and barrel names

## Report Format

In the final report:

- `Removed`: confirmed non-behavioral leftovers.
- `Concerns`: possible stale paths that need confirmation before removal.
- `Verification`: searches and checks run.

If nothing was removed, say so clearly and list any concerns found.
