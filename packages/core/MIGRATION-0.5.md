# Migrating from 0.4.0 to 0.5.0

0.5.0 changes what an error report describes. A report is now about the node whose driver failed and the error it threw, not the requester that observed it, and each failure is reported once, at its source. Node authoring, specs, and runtime APIs are unchanged.

Applies to `@frondruntime/core` and `@frondruntime/react`; section 6 also covers `@frondruntime/devtools`. If you forward Frond reports to an error tracker (Sentry, PostHog, or a custom sink), read sections 1-5. Everyone upgrading needs section 6. If you only render errors, the [Deprecated](#deprecated) section covers the renamed projection fields.

## Breaking changes

### 1. Report name, message, and fingerprint

For a wallet node whose acquire throws a `WalletInitializationFailure` tagged error (with a plain `Error` as its `cause`), read through a session node:

```
// 0.4.0
name         FrondDiagnosticError
message      Frond readiness failed: Error
fingerprint  frond:readiness:Error:app/session

// 0.5.0
name         FrondDiagnostic.WalletInitializationFailure
message      [app/wallet acquire] Wallet SDK initialization exceeded 10000ms.
fingerprint  frond:readiness:app/wallet:acquire:WalletInitializationFailure
```

- `report.error.name` is `FrondDiagnostic.<causeType>`. The cause type is the error the failing node's driver threw: a tagged error's `_tag`, else the error's `name`. Plain carriers (`Error`, untagged `UnknownError`) are skipped in favor of the tagged error they carry. When Frond itself is the cause, the cause type is the Frond tag, for example `DriverOperationTimedOut` or `CycleDetected`.
- 0.4.0 used the deepest non-wrapper error in the chain, so a tagged error wrapping a plain `Error` reported as `Error`. A tagged error with no inner cause already reported under its own tag in 0.4.0.
- `report.error.message` is `[<failing node tag> <operation>] <cause message>`. Without a failing node there is no `[...]` prefix. The kind-prefixed 0.4.0 messages (`Frond readiness failed: X`, `Frond operation failed: X`, `Frond live work failed: X`, `Frond unexpected error: X`, `Frond invalid graph: X`, `Frond runtime: X`) are gone.
- `report.fingerprint` is `["frond", kind, failingNode, operation, causeType]`. For unclassified causes (`Error`, or a `Thrown*` type) it adds the cause message, masked (ids and numbers replaced) and truncated to 120 characters. Segments that do not apply are omitted. The order changed from 0.4.0, and `unexpected` fingerprints no longer include a value-kind segment.

Forward `report.fingerprint` to your tracker as it is. Do not rebuild it from tags or contexts; its segments are not a stable API.

Expect existing tracker issues to regroup once: one failure seen by two requesters was two issues in 0.4.0 and is one issue now.

### 2. Report tags

| 0.4.0 | 0.5.0 |
| --- | --- |
| `frond.root_tag` | `frond.cause_type` |
| `frond.node_tag` (the requester) | `frond.failing_node` (the node whose driver failed) |
| - | `frond.requester` (the node that asked; `"unknown"` when none) |
| - | `frond.operation` (`acquire`, the action name, `refresh`, ...; `"none"` when absent) |

`frond.kind` is unchanged. `frond.retryable` changed for sink reports: a readiness failure reported by the runtime sink now says `"true"`, where 0.4.0 said `"false"`. A report built from a thrown read error still follows that error's `retryable` flag. Sink event tags (`frond.runtime_id`, `frond.event_*`) are unchanged.

Mappings that read `frond.root_tag` or `frond.node_tag` get `undefined` on 0.5.0:

```ts
// 0.4.0
const properties = {
  cause: report.tags["frond.root_tag"],
  node: report.tags["frond.node_tag"],
};

// 0.5.0
const properties = {
  cause: report.tags["frond.cause_type"],
  node: report.tags["frond.failing_node"],
  requester: report.tags["frond.requester"],
  operation: report.tags["frond.operation"],
};
```

### 3. Report contexts and cause

`report.contexts.frond` describes the failing node:

- `causeType` and `causeMessage` replace `rootTag` and `rootMessage`.
- `failingNode` and `requester` are `{ id, tag }` references. `failingNode` replaces `nodeId` / `nodeTag`.
- `path` lists node tags from the requester to the failing node. `operation` names the failing operation. `dependency` names the dependency slot when a dependency failed. `messageType` is the type of the error that supplied `causeMessage`.
- `headline`, `summary`, `kind`, and `retryable` keep their names.

Other changes on the report:

- `report.contexts.causeChain` starts at the failing node's failure, so it never includes a dependency aggregate frame.
- `report.contexts.dependencyFailures` is removed. When several dependencies fail together, the runtime sink sends one report per unreported member, each with its own chain. A report built from the aggregate (for example `getErrorReport(error)` in an error boundary) describes one selected member. For every member's chain, use `Diagnostics.projectError(error).causeChain`: projection serialization now walks into `DependencyFailures.failures` and includes `ActionFailed.action`.
- `report.error.cause` is the failing node's own failure, not the raw value passed in. Trackers that walk `cause` see a shorter chain.
- `report.extra.rawPreview` previews that same failure.

### 4. Which runtime events report

Each failure is reported once, at its source. Readiness failures are reported by the new `GraphNodeReadinessFailed` runtime event. Action and refresh failures are reported by `GraphActionFailed` / `GraphRefreshFailed`, as before. With `Diagnostics.createRuntimeReportSink`, `handleReport` is called:

- once per failed readiness attempt (implicit acquire, `ensureReady`, expiry re-acquire), for the node whose driver failed;
- once per failed action or refresh whose driver failed.

It is no longer called for:

- dependents whose readiness failed only because a dependency failed, which was already reported at the dependency;
- `ensure` / `boot` calls that only observe a stored readiness failure (an invalid graph still reports);
- actions and refreshes that failed only because their node or a dependency failed to become ready.

When several dependencies fail together, each failure that was not already reported gets its own report.

Retry behavior is unchanged: `ensureReady` on a failed node, and an action on a failed node, start a new readiness attempt. Each attempt that fails is a real failure and is reported. Its reports share one fingerprint, so they group into one tracker issue.

Custom sinks that classify events themselves should use `Events.isReportable(event)` (or `Events.classify(event).reportable`) rather than matching event tags; it encodes the rules above.

### 5. Report identity

Reports are memoized per failure. For one failure, these are the same `Error` object, including when an error boundary catches a dependent's error:

- the runtime sink's `report.error`;
- `Diagnostics.createErrorReport(error).error` in core;
- `getErrorReport(error).diagnostic.error` in `@frondruntime/react`.

Trackers that dedupe by error identity send one event.

### 6. Effect 4 stable

The `effect` peer dependency of `@frondruntime/core`, `@frondruntime/react`, and `@frondruntime/devtools` is now `^4.0.0`. Effect 4 betas and release candidates no longer satisfy it, so upgrade `effect` to a stable 4.x release along with Frond. Effect's own beta-to-stable changes that may reach app code include:

- `effect/unstable/*` modules moved to `effect/*`, for example `effect/unstable/rpc` → `effect/rpc`.
- `Schema.TaggedErrorClass` → `Schema.TaggedError`, and `Schema.ErrorClass` → `Schema.Error`.

## Deprecated

`Diagnostics.projectError(...)` and the React projection keep these fields as aliases; they will be removed in a future major:

| Deprecated | Use |
| --- | --- |
| `rootTag` | `causeType` |
| `rootMessage` | `causeMessage` |
| `nodeId` | `failingNode.id` |
| `nodeTag` | `failingNode.tag` |

The React `FrondReactErrorReport` also gains top-level `causeType`, `causeMessage`, `failingNode`, `requester`, and `path`.

## Fixes worth knowing

- `ensureReady`, `ensureReadyNode`, and `boot` now honor `metadata.signal`. Aborting interrupts that awaiter; the shared readiness attempt keeps running for other awaiters. An aborted `ensureReady` currently rejects with Effect's "All fibers interrupted without error" error rather than a typed cancellation.
