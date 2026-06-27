---
name: typescript-strict
description: Use when writing, refactoring, reviewing, or debugging strict TypeScript in this repo, including tsconfig paths, package exports, typecheck failures, unknown vs any, readonly data, module boundaries, and Effect language-service diagnostics.
---

# TypeScript Strict

Use this skill for TypeScript mechanics that are not specific to Effect.

## Repo Facts

- Root `tsconfig.json` is strict and no-emit.
- Module mode: `Preserve`; module resolution: `bundler`.
- TS extension imports are allowed.
- `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noPropertyAccessFromIndexSignature` are enabled.
- `@effect/language-service` is configured in root `tsconfig.json`.
- Root typecheck runs package configs explicitly.

## Type Rules

- Prefer `unknown` over `any` at external boundaries.
- Narrow `unknown` before use.
- Use explicit return types on exported functions when they define public API.
- Use `ReadonlyArray<T>` and readonly object fields for inputs and data contracts.
- Prefer literal unions or `as const` objects over numeric enums.
- Use template literal types or branded types for structured strings that cross boundaries.
- Avoid non-null assertions; prove presence through narrowing.
- Avoid type assertions that erase useful errors or requirements.

## Type-First Modeling

For new public APIs, protocols, or domain states, design the type shape before filling in implementation details.

1. Define the data model: IDs, state variants, schemas, and external wire shape.
2. Define function signatures: input, output, recoverable errors, and Effect requirements.
3. Implement to satisfy the types; let compiler errors expose missing cases.
4. Validate at boundaries where unknown data enters or leaves the system.

Rules:

- For Frond runtime/graph public types, check `AGENTS.md`, package READMEs, public docs, and current code before naming.
- Use stable names; do not create aliases such as `Ref`, `NodeInstance`,
  `NodeClass`, `NodeDefinition`, or `AdapterSnapshot`.
- Make illegal states unrepresentable with discriminated unions instead of correlated optional fields or boolean flags.
- Use branded/schema-backed IDs for values that cross package, persistence, tool, or RPC boundaries.
- Prefer constructors/builders for exported protocol variants so defaults and `_tag` literals are centralized.
- Avoid booleans by default for domain state. Use booleans only for truly binary values that are unlikely to grow into a state space.
- Prefer discriminated unions for simple states and an explicit state-machine module/service for complex state transitions.
- Prefer explicit required inputs over optional-parameter soup. If a value has a meaningful default, normalize it once at the boundary into a required field.
- Use explicit domain sentinels or variants when absence has semantics; do not rely on omission to mean a real state.
- Use exhaustive matching for closed internal protocols. Unknown internal variants are defects, not fallback cases.
- Avoid stringly typed protocols when the set is closed. Use literal unions or schemas.
- Use `satisfies` when checking object shape without widening or erasing useful literal information.
- Let TypeScript infer local obvious values, but write explicit return types for exported functions that define public API.

## Module And Package Rules

- Keep package public exports intentional.
- Match `package.json` exports with actual source entrypoints.
- Use workspace path mappings from package `tsconfig.json`; do not invent import paths.
- Keep browser-safe packages free of Bun-only imports.
- Keep generated `dist/` output derived from source.

## Typecheck Workflow

1. Read the relevant package `tsconfig.json`.
2. Reproduce with the narrow package typecheck if available.
3. Fix the type model, not just the local symptom.
4. Run `bun run typecheck` for cross-package signatures, exports, schemas, or shared types.

## Error-Handling Types

- Use typed result/error models for recoverable failures.
- In Effect code, preserve the `E` channel instead of collapsing errors to `unknown`.
- In non-Effect code, prefer discriminated unions for recoverable results when exceptions are not the right boundary.
- Do not silently default malformed or incomplete input unless the default is a named domain rule for an omitted value. If a caller provides an invalid config, query, policy, or protocol value, fail loudly with a typed/invariant error instead of guessing.
- Do not coerce invalid provided values by clamping, flooring, truncating, widening to unbounded, or replacing with a default unless the design explicitly names that behavior.
- Recover from expected external uncertainty; fail loud on impossible internal states and violated invariants.
- When converting foreign errors, add stable context without leaking secrets or large payloads.

## Anti-Patterns

- Do not use `as any` or `as never` to escape a type error without explaining the invariant.
- Do not widen closed sets to `string` unless external extensions can add values at runtime.
- Do not use `T[]` for input collections that should not be mutated.
- Do not add default exports to packages that use named export style.
- Do not hide package-boundary type errors by changing root compiler options.
- Do not model mutually exclusive states as one object with many optional fields.
- Do not model lifecycle or protocol state as a matrix of booleans.
- Do not use broad index signatures when explicit keys or a typed map would preserve more information.
- Do not build object literals with conditional spread fragments like `...(x !== undefined ? { x } : {})`. Normalize options first and pass an explicit required object.
- Do not scatter nullish defaults through function bodies. Defaults should live in constructors, boundary normalizers, config layers, or clearly named constants.
- Do not let defaults creep inward through multiple call layers. Once normalized, pass the explicit normalized value.
- Do not add default branches that hide unsupported internal message types, protocol variants, or state transitions.
- Do not use `Partial<T>` for domain update APIs. Prefer named commands such as `recordUsage`, `markCompleted`, or `setIteration`. `Partial<T>` is acceptable for tests, low-level persistence plumbing, or external patch surfaces after normalization.
