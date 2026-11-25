# Migrating from 0.6 to 0.7

0.7 changes how results are stored and how React and MobX readers see them.
Committed results are plain data, shared structurally between commits:
a write makes new objects only along the path it changed, and every other
object keeps its identity. `node.result` is that committed value, behind one
observable reference per node. Node authoring, specs, drivers, and imports are
unchanged.

The rule to keep in mind: **a new object means new data, the same object
means the same data.** Pass rows to `observer` rows as props, and only the
rows that changed render again.

## Required change

### `development` and `eventBufferSize` are required runtime options

`createRuntime` takes an options object with `development` and
`eventBufferSize`. Leaving either out fails the type check, and calling
without them throws `FrondRuntimeInvariantViolation` at runtime.
`createTestRuntime` from `@frondruntime/core/testing` defaults them to
`development: true` and `eventBufferSize: 512`.

```ts
const development = import.meta.env.DEV; // React Native: __DEV__
Frond.createRuntime({
  development,
  eventBufferSize: development ? 512 : 0,
});
```

Frond no longer reads `process.env.NODE_ENV`. `development: true` turns on
every development check: committed results are frozen (§1), a re-plan
re-checks a node's dependencies, and `useNode` and `useNodes` throw outside an
`observer` (§3). Pass `false` in production builds. The React adapter reads
the flag from the runtime given to `FrondProvider`.

The buffer feeds `events()`, the `RuntimeEvents` query, and runtime
snapshots. Observers and sinks see every event whatever the size. With 0,
`waitForRuntimeEvent(runtime)` finds nothing and devtools snapshots carry no
`sequence`, so give a nonzero size wherever those are used. `createTestRuntime`
and the test harness default `eventBufferSize` to 512 and `development` to
`true`.

### `Frond.MobX` is removed

`MobX.createNode`, the `MobXNode*` types, and `FrondMobXProjectionError`
are gone. Read the class node returned by the handle instead: `node.result`
is the reactive read. In React, use `useNode` inside an `observer`.

```ts
// Before
const projection = Frond.MobX.createNode(runtime, SessionNode, {});
// After
const handle = runtime.client.node(SessionNode, {});
const node = await handle.ensureReadyNode();
const result = node.result;
```

## Behavior changes

### 1. Committed results are read-only, and frozen in development

Every value a node commits is read-only: what a driver's `acquire` or
`refresh` returns, what `setResult` receives, and what a patch or updater
produces. `handle.read().result` returns that value. With `development: true`
it is deep-frozen, and writing to it throws a `TypeError` in strict mode. With `development: false`
it is not frozen, because frozen arrays are slow and large on JavaScriptCore
(Safari, iOS, Bun), and nothing stops a write: such a write is a bug the
development build would have thrown on. For example, a `refresh` that
mutates the previous result and returns that same object commits the new
value, but `node.result` keeps its reference, so `observer` readers do not
render again, and every holder of the old snapshot, devtools history
included, sees the new value. An updater is not affected: it gets a draft.

In development, freezing reaches objects the caller still holds. A fixture,
a module-level cache, or an SDK object passed to `setResult` or returned from
`acquire` is frozen for its owner too, and a later write to it throws far
from the cause. Pass a copy when you keep the original.

### 2. `node.result` is the committed value, shared between commits

`node.result` (and `useNode(...).result`) is the value the node committed: the same object `handle.read().result` returns. The node holds it
in one `observable.ref`, so a commit that changes the result notifies every
reader of `node.result` once, and a commit equal to the current result
notifies nobody and keeps the old reference. This keeps MIGRATION-0.6 §1 and
§3.

- **Identity follows data.** A write gives `node.result`, and every object on
  the path to what changed, a new reference. Everything else keeps the object
  the previous commit had. Reference checks (`React.memo`, `observer` props,
  `useMemo` deps, `toBe`) see exactly the parts that changed.
- **Rows keep their object when they move.** A refresh, a `setResult`, a
  patch, or an updater that returns rows equal to rows of the previous commit
  gets the previous row objects back, wherever they now sit: a prepend, a
  removal, a filter, a reorder, or a fresh copy from the server. A row that
  changed is a new object. Matching is by value, not by id: two equal rows
  may share one object.
- **No per-field reactivity for plain data.** A reader of `node.result`
  reruns on any change to that node's result, not only on the fields it
  read. Split the work by passing the parts down: an `observer` row that
  takes its row as a prop skips the render when the row object is unchanged.
- **Models keep their own reactivity.** Class instances, author MobX
  observables, `Map`, `Set`, and `Date` inside a result are held by reference,
  not frozen or copied. A patch with `resultPatch: { nonPlainClone: "share" }`
  on MobX-observable models notifies only readers of the changed observable
  fields. This applies to an observable root and to observable models inside
  plain data. Frond treats each observable boundary as self-notifying and
  does not inspect its contents. If the result also holds non-observable
  non-plain values outside those boundaries, such as plain class instances,
  `Map`, `Set`, or `Date`, a share patch still notifies every `node.result`
  reader.
- **Read-only.** Writing to it throws in development, as §1 says. Commit changes through
  `patchResult`, `setResult`, or an updater.

### 3. `useNode` and `useNodes` must run inside an `observer`

A result write reaches React only through MobX: `useNode` and `useNodes` do
not rerender a component when the result changes. This supersedes
MIGRATION-0.6 §2.

- With `development: true`, `useNode`
  and `useNodes` throw `FrondReactUsageError` on every call outside a MobX
  `observer` component, so the mistake fails the render that makes it. Wrap
  the component in `observer` from `mobx-react-lite`. Server rendering with
  `enableStaticRendering(true)` is exempt.
- With `development: false` nothing is checked: a component outside an `observer` shows
  the first result it rendered and does not update on writes.
- A child that receives result data as props and renders it must itself be
  an `observer`, or a plain component that renders from props alone.
  `Preload` does not read results and needs no `observer`.

### 4. Patch recipes and updaters get copy-on-write drafts

A recipe or updater receives a draft. Unchanged branches are shared with the
previous commit, not copied. The draft is revoked after the recipe returns,
so keep no reference to it, and `structuredClone` of a draft fails: copy with
a spread or JSON inside a recipe. A recipe that changes nothing, or writes
values equal to the old ones, keeps the old reference and notifies nobody. `Object.defineProperty` on a draft is
dropped. A string property on a committed array (`rows.label = "x"`) is dropped the
next time a patch writes that array.

### 5. `@frondruntime/react` requires React 19 and suspends through `use()`

`useNode`, `useNodeState`, and `useNodes` suspend with React's
`use(promise)` instead of throwing a promise, so the adapter's peer range is
now `react >=19`. Each pending read hands React one cached promise per
readiness attempt, so a remount or a rebuilt reader does not suspend on a new
promise, and a read whose attempt has already settled skips the suspend.

In tests, React does not retry a component suspended by `use()` inside a
synchronous `act` scope: it warns that the `act` call was not awaited, and
the Suspense fallback stays on screen. Render every tree with a Frond reader
inside an awaited `act`:

```ts
const view = await act(async () => render(<Screen />));
expect(await view.findByText("Wallet")).toBeTruthy();
```

The same applies to `rerender` and to any update that makes a reader suspend
again.

## Testing

`readySpec` also takes a function that returns the result. The function runs
on every acquire and every refresh, so a test changes what the next refresh
commits by changing what the function returns:

```ts
let rows = [{ id: "a" }];
const harness = createFrondTestHarness({
  specOverrides: [{ from: RowsNode, to: readySpec(RowsNode, () => ({ rows })) }],
});
rows = [{ id: "b" }];
await harness.node(RowsNode, {}).refresh(); // commits { rows: [{ id: "b" }] }
```

With a plain value, a refresh keeps the value. A result that is itself a
function is passed wrapped: `readySpec(Spec, () => fn)`.

## Upgrade failures: app or Frond?

Fix it in the app when a failing test or screen shows one of these:

- A type error or `options are required` from `createRuntime`: pass
  `development` and `eventBufferSize`.
- `TypeError: Attempted to assign to readonly property` (or "Cannot assign to
  read only property") in app code or a test fixture: the code writes to a
  committed result or to an object it handed to Frond. Copy it, or write
  through an action. A shared fixture reused across tests needs a fresh copy
  per test.
- `FrondReactUsageError: useNode(...) rendered outside a MobX observer`: wrap
  that component in `observer`.
- A test stuck on the Suspense fallback, with the warning "A component
  suspended inside an `act` scope, but the `act` call was not awaited":
  render inside `await act(async () => ...)` (§5).
- A peer dependency error for `react`: upgrade to React 19.
- A React screen that does not update after an action, with
  `development: false`: a component reading the result, or a child that
  renders result data, is not an `observer`.
- A component renders more often than in 0.6: it reads `node.result` and
  renders every row itself. Move each row into an `observer` row that takes
  the row as a prop.
- An assertion that a result or a nested object kept its identity across a
  write that changed it (`toBe`), or changed identity across a write that
  did not (`not.toBe`): identity now follows data; assert on values, or on
  the object the write did not touch.
- A test that waits on `waitForRuntimeEvent(runtime)` against a runtime
  created with `eventBufferSize: 0`.

Report it to Frond when:

- `node.result` and `handle.read().result` are different objects after a
  write settles.
- An `observer` component that reads `node.result` does not update after an
  action changes the result, or updates after an action that commits an
  equal result.
- A row object the write did not change gets a new identity, outside the
  value-based matching described in §2 (for example, an unchanged row object
  is replaced in a patch that edits another row).
- An action returns `Failure` for a recipe or updater that worked in 0.6,
  other than `structuredClone` of a draft.
- A thrown error comes from inside `@frondruntime/*` and is not one of the
  above.
