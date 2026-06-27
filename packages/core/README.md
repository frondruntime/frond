# @frondruntime/core

Core Frond runtime package: node authoring, graph execution, lifecycle, diagnostics, signals, and test harnesses.

## Install

```sh
bun add @frondruntime/core effect mobx
```

`effect` is a peer dependency for Effect-facing driver and runtime APIs. `mobx` is a peer dependency because Frond node state is MobX-backed and must share the app's MobX runtime.

## What It Owns

- `createRuntime` and the runtime client.
- `NodeBase`, `NodeSpec`, node spec constructors, tags, keys, dependencies, and result commits.
- `Driver.Async` and `Driver.Effect` authoring wrappers.
- Graph/runtime types under `Frond.Graph`, `Frond.Runtime`, `Frond.Events`, `Frond.Signals`, and `Frond.Diagnostics`.
- MobX-facing node helpers under `Frond.MobX`.
- Testing helpers under `@frondruntime/core/testing`.

## Minimal Node

```ts
import * as Frond from "@frondruntime/core";

type SessionSpec = Frond.NodeSpec<{
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: { readonly userId: string | null };
}>;

export class SessionNode extends Frond.NodeBase<SessionSpec> {
  static readonly spec = Frond.serviceSpec<SessionSpec>({
    tag: Frond.tag("app/session"),
    key: () => Frond.Key.singleton(),
    driver: Frond.Driver.Async<SessionSpec>({
      acquire: Frond.Driver.Acquire(async () => ({ userId: null })),
    }),
  });

  get isSignedIn(): boolean {
    return this.result.userId !== null;
  }
}
```

## Runtime Usage

```ts
const runtime = Frond.createRuntime();
const session = runtime.client.node(SessionNode, Frond.Args.none);

await session.ensureReady();
const read = session.read();
```

Only ready reads expose the authored node instance. Pending, error, invalid, unavailable, and unwired reads expose lifecycle data, not partial node objects.

## Testing

```ts
import * as FrondTest from "@frondruntime/core/testing";
```

The testing subpath includes runtime harnesses, deferred drivers, and spec helpers used to test node behavior without React.

## Docs

- Install: https://frondruntime.dev/docs/start/install
- First node: https://frondruntime.dev/docs/start/first-node
- Public surface: https://frondruntime.dev/docs/reference/public-surface

Release notes for this package are generated from Conventional Commits.
Squash-merged PR titles provide the release-note subject for this package.
Release smoke tests verify GitHub release metadata before npm publishing.
