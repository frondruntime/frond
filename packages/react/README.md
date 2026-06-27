# @frondruntime/react

React adapter for Frond: provider, Suspense-ready node hooks, preload, controls, error recovery, and React testing helpers.

## Install

```sh
bun add @frondruntime/core @frondruntime/react effect mobx mobx-react-lite
```

`@frondruntime/react` depends on a runtime from `@frondruntime/core`. `effect`, `mobx`, and `react` are peer-level runtime contracts. Components that read observable node fields should use `observer` from `mobx-react-lite`.

## Provider

```tsx
import * as Frond from "@frondruntime/core";
import * as FrondReact from "@frondruntime/react";

const runtime = Frond.createRuntime();

export function App() {
  return (
    <FrondReact.FrondProvider runtime={runtime}>
      <Routes />
    </FrondReact.FrondProvider>
  );
}
```

## Read A Node

```tsx
import * as FrondReact from "@frondruntime/react";
import { observer } from "mobx-react-lite";

const ProfilePanel = observer(({ userId }: { userId: string }) => {
  const profile = FrondReact.useNode(ProfileNode, { userId });

  return <h1>{profile.displayName}</h1>;
});
```

`useNode` suspends while readiness is pending and throws readiness failures to the nearest error boundary. The render path only receives a ready authored node instance.

## Runtime Lifecycle Hooks

- `useNode` - ready node or Suspense/error.
- `useNodeState` - ready node plus operation state, result validity, and last operation failure.
- `useNodes` - keyed map of ready nodes.
- `useNodeControls` / `useNodesControls` - refresh, evict, and release without rendering the node.
- `Preload` - acquire nodes before rendering children.
- `getErrorReport` / `getErrorRecovery` - project runtime read errors into UI error boundaries.

## Testing

```ts
import * as FrondReactTest from "@frondruntime/react/testing";
```

The testing subpath exports `TestFrondProvider` for React tests that need an isolated runtime.

## Docs

- React provider: https://frondruntime.dev/docs/react/provider
- useNode: https://frondruntime.dev/docs/react/use-node
- Suspense and errors: https://frondruntime.dev/docs/react/suspense-and-errors
