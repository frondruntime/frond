---
name: effect-observability-time
description: Use when adding or reviewing Effect time, retry, timeout, Clock/Duration, logging, tracing spans, metrics, Config, ConfigProvider, Redacted secrets, or operational observability in Frond.
---

# Effect Observability And Time

Use this skill for time-based behavior, retries, logs, spans, metrics, and runtime config.

## Time And Retry

Use Effect primitives instead of ad hoc timers and raw millisecond math.

```typescript
import { Duration, Effect, Schedule } from "effect"

const guarded = operation.pipe(Effect.timeout(Duration.seconds(5)))

const retryPolicy = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
)
```

Rules:

- Use `Clock` when code needs current time from the Effect environment.
- Use `Duration` helpers for time units when clarity matters.
- Use `Effect.sleep` for delays, not `setTimeout` wrapped by hand.
- Use `Effect.timeout` around external calls that can hang.
- Use `Schedule` for retry; gate retry by failure shape when only some errors are retryable.
- Public retry fields should usually accept `Schedule.Schedule<unknown>` because schedule input is contravariant.

## Logging, Tracing, Metrics

- Use `Effect.logInfo`, `Effect.logDebug`, `Effect.logError`, and `Effect.annotateLogs`.
- Use `Effect.withSpan("name", { attributes })` around meaningful runtime boundaries.
- Attach stable IDs and small primitive attributes to logs/spans; avoid dumping large payloads.
- Use `Metric.counter`, `Metric.gauge`, or `Metric.histogram` when a value is operationally useful across runs, not just useful for local debugging.
- Avoid `console.log` in Effect runtime code.

## Configuration And Secrets

- Use Effect `Config` for runtime configuration when code needs typed environment values.
- Do not read `process.env` throughout domain code.
- Read config once through a service/layer, then inject the parsed values.
- Keep secrets redacted in logs and errors.
- Use `ConfigProvider` in tests or alternate runtimes when config should come from a map/object rather than the process environment.
- Use `Redacted` for secrets and unwrap only at the final foreign boundary that needs the raw value.

## Checks

- Does this external call have timeout or cancellation behavior?
- Are retryable and non-retryable failures separated?
- Would this log leak secrets or huge payloads?
- Does the span name describe an operation rather than an implementation detail?
- Is config read at a boundary and injected afterward?
