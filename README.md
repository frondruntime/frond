# Frond

Effect-powered frontend runtime for React and MobX-facing application state.

Frond gives frontend code an explicit runtime graph: keyed node identity, dependency readiness, serialized operations, cancellation, cleanup, eviction, diagnostics, and React Suspense integration.

## Packages

- `@frondruntime/core` - runtime, node authoring, drivers, lifecycle, diagnostics, signals, testing harness.
- `@frondruntime/react` - React provider, hooks, Suspense/ErrorBoundary projection, React testing helper.

## Install

```sh
bun add @frondruntime/core @frondruntime/react effect mobx mobx-react-lite
```

Use only `@frondruntime/core` when you are not rendering with React.

## Quick Start

```ts
import * as Frond from "@frondruntime/core";

type Profile = {
  readonly id: string;
  readonly name: string;
};

type ProfileSpec = Frond.NodeSpec<{
  readonly args: { readonly userId: string };
  readonly key: Frond.Key.Structure<{ readonly userId: string }>;
  readonly result: Profile;
}>;

export class ProfileNode extends Frond.NodeBase<ProfileSpec> {
  static readonly spec = Frond.resourceSpec<ProfileSpec>({
    tag: Frond.tag("app/profile"),
    key: (args) => Frond.Key.structure({ userId: args.userId }),
    driver: Frond.Driver.Async<ProfileSpec>({
      acquire: Frond.Driver.Acquire(async (ctx) => {
        const res = await fetch(`/api/users/${ctx.args.userId}`, {
          signal: ctx.signal,
        });
        return res.json();
      }),
    }),
  });

  get displayName(): string {
    return this.result.name;
  }
}
```

```tsx
import * as FrondReact from "@frondruntime/react";
import { observer } from "mobx-react-lite";

const ProfilePanel = observer(({ userId }: { userId: string }) => {
  const profile = FrondReact.useNode(ProfileNode, { userId });
  return <h1>{profile.displayName}</h1>;
});
```

## Repository Layout

- `packages/core` - `@frondruntime/core`.
- `packages/react` - `@frondruntime/react`.
- `.biome/plugins` - local Biome Grit rules.
- `.agents/skills` - repo-local agent workflows.

## Commands

```sh
bun install
bun run test
bun run typecheck
bun run effect:diagnostics
bun run lint
```

## Documentation

- Website: https://frondruntime.dev
- Public surface: https://frondruntime.dev/docs/reference/public-surface

## Status

Pre-1.0. APIs may change while the runtime model is hardened.
