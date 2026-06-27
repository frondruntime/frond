---
name: bun-test
description: Use when creating, modifying, debugging, or running Bun tests with bun:test, including package-local test commands, async tests, mocks, spies, snapshots, and Effect.runPromise test boundaries.
---

# Bun Test

Use this skill for tests run by `bun test`.

## Repo Facts

- Root test command: `bun run test` -> `bun test`.
- Runtime tests live under `packages/core/test`.
- React adapter tests live under `packages/react/test`.
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
- Specific file: `bun test path/to/file.test.ts`.
- Package scope: run the package script if present.
- Name filter: `bun test -t "pattern"`.
- Watch mode is for local iteration, not final verification.

## Anti-Patterns

- Do not leave `test.only` or focus filters in committed tests.
- Do not use sleeps to paper over async lifecycle bugs.
- Do not assert implementation details when public behavior is available.
- Do not update snapshots unless the output change is intentional and reviewed.

