---
name: bun-test
description: Use when creating, modifying, debugging, or running Bun tests with bun:test, including package-local test commands, async tests, mocks, spies, snapshots, and Effect.runPromise test boundaries.
---

# Bun Test

Use this skill for tests run by `bun test`.

## Repo Facts

- Root test command: `bun run test` -> `bun --conditions=source test packages/core/test packages/react/test packages/rootstock/test packages/devtools/test apps/hub/test`.
- The `--conditions=source` flag is required, not cosmetic: it activates the `"source"` export condition (declared in `tsconfig.base.json` as `customConditions: ["source"]` and in each package's `package.json` `exports`), which resolves imports to `src/` instead of `dist/`. Drop it and tests silently run against stale/missing build output instead of current source.
- Runtime tests live under `packages/core/test`, including `packages/core/test/e2e`, `packages/core/test/type-contracts`, and `packages/core/test/typecheck`.
- React adapter tests live under `packages/react/test`.
- Rootstock (private, unpublished) tests live under `packages/rootstock/test`.
- Devtools client tests live under `packages/devtools/test`.
- Hub app tests live under `apps/hub/test`.
- Use package-local test scripts when a package owns the behavior.

## Imports

```typescript
import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from "bun:test";
```

Use only the APIs needed by the test. Keep setup close to the tests unless it is reused across files.

## Test Shape

- Test behavior through public exports where practical.
- Use narrow tests for boundary behavior: schema failures, typed failures, serialization, stream completion, and runtime lifecycle.
- For Effect code, run effects at the test boundary with `Effect.runPromise`.
- Assert typed failures by `_tag` and fields, not by brittle stringified output.
- For streams, assert both emitted values and completion behavior.
- For background fibers, assert interruption, shutdown, or result handoff.

## Mocks And Spies

- Use `mock` for small injected functions.
- Use `spyOn` when observing object methods.
- Restore mocks in `afterEach` when they can leak state.
- Prefer dependency injection or test layers over module mocking for Effect services.

## Commands

- Whole repo: `bun run test`.
- Specific file: `bun --conditions=source test path/to/file.test.ts`. Keep `--conditions=source` for single-file runs too; without it the file resolves workspace imports against `dist/` instead of `src/`.
- Package scope: run the package script if present (package-local `test` scripts already include `--conditions=source`).
- Name filter: `bun --conditions=source test -t "pattern"`.
- Watch mode is for local iteration, not final verification.

## Anti-Patterns

- Do not leave `test.only` or focus filters in committed tests.
- Do not use sleeps to paper over async lifecycle bugs.
- Do not assert implementation details when public behavior is available.
- Do not update snapshots unless the output change is intentional and reviewed.

