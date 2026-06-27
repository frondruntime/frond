---
name: effect-errors-schema
description: Use when modeling Effect errors, defects, Cause handling, Schema contracts, Schema.TaggedErrorClass, boundary decoding/encoding, runtime boundary validation, and typed failure recovery in Frond.
---

# Effect Errors And Schema

Use this skill for typed failures, schema contracts, and boundary normalization.

## Error Model

Use explicit domain errors. Expected failures stay in the Effect error channel. Defects are bugs, thrown exceptions, rejected promise defects, interrupts, or violated invariants.

Recovery is for expected external uncertainty: user input, network, filesystem, subprocesses, model providers, persistence, environment, and other foreign systems. Controlled internal protocol violations are defects.

Rules:

- Use `Data.TaggedError` for plain runtime/domain errors.
- Use `Schema.TaggedErrorClass` when the error must be schema-backed or serialized.
- Use `Effect.catchTag` / `Effect.catchTags` for known tagged failures.
- Use `Effect.catch` for all typed failures only when deliberately collapsing the union.
- Use `Effect.catchCause` when interrupts or defects must be inspected.
- Use `Cause.hasInterruptsOnly(cause)` to distinguish pure interruption from failure.
- Use `Effect.catchDefect` only for defect conversion at a boundary.
- Use `Effect.die`, thrown invariant errors, or equivalent hard failure for impossible internal states when types failed to prevent them.
- Do not use try/catch inside `Effect.gen` to catch Effect failures; they are not thrown.
- Do not throw expected failures.
- Do not recover from unsupported internal variants, impossible state transitions, or violated contracts with defaults, dropped events, or generic fallbacks.
- Do not recover from malformed provided runtime options, query limits, policy values, or protocol fields with coercion. Missing/omitted values may be normalized to explicit defaults at the boundary; provided invalid values should become typed failures or invariant defects.
- Do not erase error unions with `any`, `unknown`, or generic wrappers.

## Boundary Pattern

At every external boundary, normalize once:

- raw input -> Schema decode -> typed input
- foreign exception -> tagged typed failure
- domain failure -> explicit response or presentation
- defect -> logged/crashed/interrupted according to boundary policy

Examples of boundaries: tool calls, RPC handlers, SQLite calls, filesystem, subprocesses, model provider calls, WebSocket messages.

Inside the domain, keep typed values and typed failures. Do not repeatedly decode or stringify internal data. At important internal seams, validate or assert invariants and fail loudly when they are violated.

## Schema

Use Schema at external boundaries: tool inputs/outputs, RPC, persistence serialization, provider payloads, and config.

```typescript
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = Schema.Schema.Type<typeof UserId>

export class RpcError extends Schema.TaggedErrorClass<RpcError>()("RpcError", {
  code: Schema.String,
  message: Schema.String,
}) {}
```

Rules:

- Use `Schema.Struct`, `Schema.Union`, `Schema.Literal`, and `Schema.Literals` for wire contracts.
- Use `Schema.optional(...)` for optional fields in this repo.
- Use branded schemas for IDs that cross service/package boundaries.
- Decode unknown inputs with `Schema.decodeUnknownEffect(schema)(raw)` when failures should stay typed.
- Keep schemas near the boundary they protect unless they are shared API contracts.
- Put JSON parse/stringify for protocol, provider, RPC, and persistence data behind schema-backed boundary helpers when practical. Raw JSON is acceptable for tests, debug output, or truly opaque passthrough data.
- Keep raw `Record<string, unknown>` at ingress or opaque passthrough boundaries. Domain code should receive decoded schemas or explicit extension points.
- Prefer narrow schemas for commands and events. Avoid `Schema.Unknown` except for explicitly open extension points.

## Checks

- Is the failure expected and recoverable, or is it a defect?
- Does the boundary serialize or persist this error?
- Are parse failures kept typed until the boundary handles them?
- Are `_tag` values globally safe where pattern matching crosses modules?
- Is this recovery handling external uncertainty, or is it hiding a broken internal contract?
