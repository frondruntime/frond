---
name: effect-v4
description: Use when writing, reviewing, or debugging Effect v4 beta code in Frond, especially core Effect composition, Effect.gen, v3-to-v4 API translation, typed Effect signatures, and deciding which narrower Effect skill applies.
---

# Effect v4

Use this skill for general Effect mechanics and routing. For Frond runtime choices, use local Frond docs and AGENTS.md.

## Route To Narrow Skills

Load the narrower skill when the task clearly matches it:

- `effect-services-layers` - Context.Service, service interfaces, Layer construction, dependency graphs, test seams.
- `effect-errors-schema` - typed failures, defects, Cause, Schema decoding/encoding, schema-backed errors, boundary normalization.
- `effect-concurrency-lifecycle` - Fiber, Deferred, Queue, PubSub, Stream, Scope, interruption, background loops, backpressure.
- `effect-observability-time` - Clock, Duration, timeout, retry schedules, logging, tracing spans, metrics, config, redaction.
- `effect-testing-runtime` - Effect.runPromise boundaries, test layers, deterministic services, TestClock/TestContext, runtime verification.

If several apply, load only the ones needed for the change.

## Operating Model

Effect code is explicit about:

- what succeeds
- what can fail
- what services are required
- what resources must be acquired and released
- what runs concurrently and how it is interrupted

Good Effect code keeps these facts in the type signature until a deliberate boundary handles them.

Frond-specific boundary: pure description stays outside Effect. `key(args)`,
`dependencies(args)`, node spec construction, event constructors, and graph
planning are pure. Runtime execution, scopes, sinks, platform adapters,
driver hooks, event emission, clocks, generated ids, and persistence are Effect.
Use stable names from `AGENTS.md`, package READMEs, public docs, and current code.

## Workflow

Effect APIs move. Before using an unfamiliar API:

1. Search current repo usage.
2. Resolve the installed `effect` package from the lockfile or package manager layout, then inspect its local type declarations.
3. Prefer patterns already used in `packages/core`; if none exist, inspect `../theseus` for Effect v4 examples before using external material.
4. Treat web examples as v3 unless verified against local v4 types.

Useful searches:

```bash
rg "Context.Service|Layer.mergeAll|Layer.provideMerge|Effect.catchTag|Effect.forkDetach" packages
find node_modules -path '*effect*/dist/Effect.d.ts' -o -path '*effect*/dist/Schema.d.ts'
rg "export declare const catch|forkDetach|TaggedErrorClass" node_modules
```

The repo already has `@effect/language-service` configured in root `tsconfig.json`. Trust its diagnostics when Effect types look strange.

Effect language-service commands:

- `bun run effect:diagnostics` - run Effect diagnostics across configured non-web packages.
- `bun run effect:ls:check` - check whether local TypeScript is patched for build-time Effect diagnostics.
- `bun run effect:ls:patch` - patch local TypeScript so Effect diagnostics surface through compiler tooling.

## Type Shape

`Effect.Effect<Success, Error, Requirements>` means:

- `Success` - success value
- `Error` - expected typed failure
- `Requirements` - required services/environment

Expected failures belong in the error channel. Defects are bugs, thrown exceptions, rejected promise defects, or violated invariants; handle them only at boundaries.

## Core Constructors

Use the constructor that matches the boundary:

```typescript
Effect.succeed(value)        // pure success value
Effect.fail(error)           // expected typed failure
Effect.sync(() => value)     // sync, non-throwing side effect
Effect.try(() => risky())    // sync code that may throw
Effect.promise(() => p)      // promise that cannot usefully map rejection
Effect.tryPromise({          // promise with rejection normalized to typed failure
  try: () => fetchThing(),
  catch: (cause) => new FetchFailed({ cause }),
})
```

Rules:

- Use `Effect.try` / `Effect.tryPromise` at foreign boundaries.
- Normalize foreign exceptions into typed errors as early as possible.
- Do not wrap already-effectful code in `tryPromise`.
- Do not use `Effect.runPromise` as a composition tool.

## Composition

Prefer `Effect.gen` for sequential business logic and pipe combinators for local transformations.

```typescript
const program = Effect.gen(function* () {
  const user = yield* Users.find(userId)
  const account = yield* Accounts.find(user.accountId)
  yield* Audit.log({ type: "account.viewed", userId })
  return account
})
```

Rules:

- Use `Effect.map` for success-value transformation.
- Use `Effect.flatMap` when the next step returns an Effect.
- Use `Effect.tap` for effectful observation without changing the value.
- Use `Effect.all` for independent effects; set `concurrency` when work is unbounded or expensive.
- Use `Effect.partition` when partial success is a valid outcome.
- Use validation mode on collection operations only when the caller needs all failures, not fail-fast behavior.
- Keep `Effect.gen` blocks linear; extract named effects when nesting grows.
- Use `Effect.fn("Name")` for important service methods or runtime operations where tracing and better diagnostic names matter.

## Pattern Matching

Use `Match` for tagged unions or multi-branch domain logic when chained conditionals obscure exhaustiveness.

```typescript
import { Match } from "effect"

const render = Match.type<Event>().pipe(
  Match.tag("Started", (event) => `started ${event.id}`),
  Match.tag("Done", (event) => `done ${event.id}`),
  Match.exhaustive,
)
```

Rules:

- Prefer `Match.tag` / `Match.tags` for `_tag` unions.
- Prefer exhaustive matching when the input union is closed.
- Keep simple two-branch cases as normal conditionals when that is clearer.

## v4 Translation Table

Common v3 or stale examples need translation:

| Stale pattern | Effect v4 pattern |
|---|---|
| `Effect.catchAll` | `Effect.catch` |
| `Effect.catchAllDefect` | `Effect.catchDefect` |
| `Context.Tag` for services | `Context.Service<Service, Shape>()("Name")` |
| uncurried `Layer.effect(Tag, effect)` | `Layer.effect(Tag)(effect)` |
| `ServiceMap.Service` | removed; use `Context.Service` |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` for schema-backed failures |
| bare millisecond numbers for time | `Duration.millis`, `Duration.seconds`, or accepted duration strings when verified |
| `throw` in `Effect.gen` | `return yield* Effect.fail(error)` or `return yield* error` for yieldable errors |

Do not cargo-cult `Effect.Service` unless local v4 types and repo patterns support it for the case at hand. This repo currently uses `Context.Service`.

## Anti-Patterns

Avoid these unless the file is explicitly a process/test/script boundary:

- `Effect.runPromise` or `Effect.runSync` inside services or domain functions.
- `throw` for expected failures inside `Effect.gen`.
- `try/catch` around `yield*` expecting to catch typed Effect failures.
- `console.log` in runtime code.
- direct `process.env` access outside config boundaries.
- `Option.getOrThrow` in runtime code.
- unbounded queues or concurrency without an explicit bounding argument.
- type assertions that erase the error or requirements channel (`as any`, `as never`) instead of fixing the layer/error model.

## Frond Checks

Before finalizing Effect changes:

- Search for matching local patterns.
- Re-read the involved service/layer/error signatures.
- Check whether the code is at a boundary or inside the domain; choose schemas/errors accordingly.
- Run the narrow package test when behavior changed.
- Run `bun run typecheck` after service, layer, schema, or error-channel changes.
- If an API was inferred from external material, verify it in the locally installed Effect type declarations before committing the pattern.
