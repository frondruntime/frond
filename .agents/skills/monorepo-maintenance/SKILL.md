---
name: monorepo-maintenance
description: Use when changing Frond package boundaries, splitting or moving modules, shaping public exports, naming APIs, reducing large files, or reviewing repo structure and maintainability.
---

# Monorepo Maintenance

Use this skill for structural changes: package ownership, file shape, public API names, barrels, dependency direction, and maintainability reviews.

## First Pass

1. Read the nearest `package.json`, `tsconfig.json`, and current package exports before moving code.
2. Search for existing naming and module patterns with `rg`.
3. Identify the owning package before adding a type, service, runtime implementation, fixture, or test.
4. Prefer the smallest boundary that removes real coupling or file growth.
5. After moves or export changes, run the narrow typecheck or the root typecheck when signatures cross packages.

## Package Ownership

- `packages/core` owns the public Frond runtime package.
- Future packages must have one clear reason to exist: runtime, testing, React adapter, devtools, or node packages.
- Cross-package contracts belong in the lowest package that can own them without importing implementation concerns.
- Effect services and layers that are runtime internals belong with the runtime package that executes them.
- React adapter code must not own runtime orchestration.
- Node packages must depend on Frond, never the reverse.

## File Shape

- Prefer modules with one reason to change.
- Split files when they mix public types, service tags, service implementations, graph algorithms, driver execution, serialization, fixtures, and test helpers.
- Keep orchestration files shallow: wire named pieces together, but move behavior into focused modules.
- Avoid `utils.ts`, `helpers.ts`, `common.ts`, giant `types.ts`, and miscellaneous service bags. Prefer small named modules/services with a domain responsibility and direct tests.
- Avoid speculative abstractions. Add an abstraction for a real boundary, an important domain concept, or at least two real callers.
- Do not split only by syntax category if the result separates code that must always be read together.
- Keep test fixtures and mocks out of production modules unless they are explicitly exported test utilities.

## Public API And Naming

- Check `AGENTS.md`, package READMEs, public docs, and current code before naming runtime, graph, node, React, or MobX concepts.
- Prefer namespace-style public APIs where the imported namespace carries meaning.
- Prefer `Frond.Runtime.*`, `Frond.Graph.*`, and `FrondReact.*` groupings over
  loose top-level exports when adding new public concepts.
- Use one term per concept: node spec, node, driver, runtime, dependency, command, disposer, scope.
- Keep runtime shell names under Runtime; keep graph/node execution names under
  Graph; keep React rendering names under React.
- Keep generic parameter order stable for related public types.
- Prefer named constructors for repeated protocol variants so call sites do not duplicate `_tag` literals or default fields.
- Keep public names short when the namespace already supplies context.
- Keep globally matched runtime error classes prefixed when their `_tag` values must be unique.

## API Surface Design

- Public APIs should expose Frond domain intent, not implementation mechanics.
- Exported functions that define package or runtime contracts should have explicit return types.
- Avoid boolean parameter pairs and ambiguous positional flags. Use named options or discriminated unions.
- Normalize optional input once at the boundary; downstream code should receive explicit values.
- Avoid `Partial<T>` patch APIs for domain records. Prefer named commands with explicit invariants.
- Internal event/action names should be literal unions, schemas, or constructors. Plain `string` is for externally extensible names or raw undecoded input.
- If ordering matters, encode it in the API with an ordered type, sequence number, priority, timestamp, or named ordering rule.
- Keep APIs narrow at the boundary and composable inside the package. Do not export helper internals just because tests or one consumer can reach them.

## Barrels And Exports

- Keep package barrels thin. They should expose the public surface, not contain runtime behavior.
- During authorized refactors/replacements, do not add compatibility exports, duplicate old/new paths, or alias layers unless the user explicitly requires back compatibility.
- When an authorized replacement removes a public path without back compatibility, remove stale exports, comments, tests, and docs in the same pass when feasible.
- Match `package.json` exports, TypeScript path aliases, and source entrypoints.

## Review Checklist

- Does every changed module have one clear owner?
- Did any package import upward into a higher-level package?
- Did a public API expose implementation details or ambiguous boolean flags?
- Did a file start mixing contracts, implementation, graph state, driver execution, and tests?
- Did a move leave stale exports, compatibility shims, or duplicate concepts?
- Is verification scoped to the packages whose public surface changed?
