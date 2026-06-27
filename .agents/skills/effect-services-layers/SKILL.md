---
name: effect-services-layers
description: Use when defining or wiring Effect services in Frond, including Context.Service, service interfaces, Layer.effect/succeed/mergeAll/provideMerge, dependency graphs, runtime construction, and test seams.
---

# Effect Services And Layers

Use this skill for replaceable dependencies and runtime wiring. Keep domain methods as effects and construction in layers.

## Workflow

1. Search current service/layer patterns before adding a new style.
2. Inspect local Effect type declarations for unfamiliar `Context` or `Layer` APIs.
3. Check `AGENTS.md`, package READMEs, and public docs before naming Frond runtime or graph services.
4. Decide whether the dependency is a primitive contract, infrastructure adapter, runtime service, graph service, or test seam.
5. Keep service interfaces free of construction details.

## Service Shape

```typescript
import { Context, Effect, Layer } from "effect"

interface UsersService {
  readonly find: (id: UserId) => Effect.Effect<User, UserNotFound>
}

export class Users extends Context.Service<Users, UsersService>()("Users") {}

export const UsersLive = Layer.effect(Users)(
  Effect.gen(function* () {
    const db = yield* Db
    return Users.of({
      find: (id) => db.queryUser(id),
    })
  }),
)
```

Rules:

- This repo currently prefers `Context.Service<Service, Shape>()("Name")`.
- Match service names to stable Frond vocabulary. Examples:
  `FrondRuntime`, `RuntimeEventBus`, `RuntimeScope`, `GraphSystem`.
- Do not cargo-cult `Effect.Service` unless local v4 types and repo patterns support it for the case at hand.
- Declare service requirements in return types; do not hide them with `any`.
- Use `Layer.succeed(Service)(implementation)` when the implementation already exists.
- Use `Layer.effect(Service)(effect)` when construction needs effects or dependencies.
- Compose same-level layers with `Layer.mergeAll`.
- Use `Layer.provideMerge` when wiring dependencies into another layer while preserving provided services.
- Avoid repeated `Effect.provide` inside hot paths; provide layers at composition boundaries.

## Boundaries

- Runtime services, clocks, random/id generation, stores, language models, and mutable context should be read from the Effect environment at execution time.
- Constructors and factories may capture static configuration.
- Constructors/builders should shape data and service values only. They should not perform I/O, allocate runtime resources, read config, call providers, or start fibers.
- Runtime code should avoid ambient `Date.now()`, `new Date()`, `Math.random()`, and direct random UUID generation. Use services/layers or explicit injected providers; boundary adapters and tests may wrap those primitives.
- Do not call `Effect.runPromise` or `Effect.runSync` inside services. Run effects at process, test, or script edges.
- For test seams, provide alternate layers instead of conditionals inside production services.

## Checks

- Is this dependency replaceable in tests?
- Does the service interface expose behavior, not its implementation backend?
- Did layer wiring preserve requirements the caller still needs?
- Did the change introduce a package dependency in the wrong direction?
