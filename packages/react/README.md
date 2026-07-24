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

## Read Without Suspense

```tsx
const ProfileBadge = observer(({ userId }: { userId: string }) => {
  const read = FrondReact.useNodeRead(ProfileNode, { userId });

  switch (read._tag) {
    case "Ready":
      return <h1>{read.result?.displayName}</h1>;
    case "Pending":
      return <Spinner />;
    case "Error":
      return <RetryBanner error={read.error} />;
    default:
      return null; // Unwired | Idle
  }
});
```

`useNodeRead` never throws to Suspense or an error boundary. It returns the runtime read as a tagged union - `Unwired | Idle | Pending | Ready | Error` - for components that must render every state inline instead of delegating to a boundary. It still drives the same cold-start readiness boot and subscribes to changes, so the node makes progress exactly as it would under `useNode`/`useNodeState`.

## Runtime Lifecycle Hooks

- `useNode` - ready node or Suspense/error.
- `useNodeState` - ready node plus operation state, result validity, and last operation failure.
- `useNodeRead` - non-throwing tagged read for rendering every state inline.
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

## AI use

Frond is AI-assisted (mainly Claude and Codex), iterated over months rather than one-shot generated. Full note: https://frondruntime.dev/ai-use
