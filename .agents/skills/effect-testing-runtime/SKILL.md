---
name: effect-testing-runtime
description: Use when testing or verifying Effect code in Frond, including Effect.runPromise boundaries, test layers, fake services, deterministic time, config providers, stream/fiber tests, and runtime edge behavior.
---

# Effect Testing And Runtime

Use this skill for testing Effect programs and deciding where effects are run.

Use the `bun-test` skill for Bun test runner APIs and the `testing-patterns` skill for repo-level test placement.

## Runtime Boundary

- Run effects at process, test, or script edges.
- Do not call `Effect.runPromise` or `Effect.runSync` inside services or domain functions.
- In tests, build the program, provide test layers, then run it at the test boundary.

```typescript
import { Effect } from "effect"
import { expect, test } from "bun:test"

test("returns user", async () => {
  const result = await Effect.runPromise(
    Users.find("user-1").pipe(Effect.provide(UsersTestLive)),
  )

  expect(result.id).toBe("user-1")
})
```

## Test Services

- Prefer test layers and fake services over global mutation.
- Use deterministic services for time, randomness, IDs, storage, language models, and config.
- Use `ConfigProvider` when config should come from a map/object rather than the process environment.
- Keep typed expected failures in the error channel when that is the contract being tested.
- Test defects separately from expected domain failures.

## Concurrent And Streaming Tests

- For streams, test completion semantics as well as emitted values.
- For background fibers, test interruption or shutdown behavior.
- Do not hide timing problems with sleeps; use deterministic signals such as `Deferred`, queue events, or test clocks when available.
- When testing time-based behavior, verify local Effect test-clock APIs before using them.

## Checks

- Is the effect run only at the test boundary?
- Are all required services provided intentionally?
- Does the test assert typed failures rather than stringified defects?
- Does the test prove shutdown/completion for fibers, queues, and streams?
- Should the package-local test run be enough, or did public signatures require root typecheck?
