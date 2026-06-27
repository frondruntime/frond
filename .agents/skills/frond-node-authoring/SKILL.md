---
name: frond-node-authoring
description: Use when creating, migrating, reviewing, or cleaning up Frond node authoring in this repo, including NodeSpec carriers, NodeBase classes, static specs, Driver.Async/Effect hooks, dependencies, actions, liveness, refresh.
---

# Frond Node Authoring

Use this skill for Frond node authoring and migrations. The current golden path is the static-spec, contract-first shape used by public Frond node authoring.

## Target Shape

Author the type carrier first, then the class, then the static descriptor:

```ts
type OrdersSpec = Frond.NodeSpec<{
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly deps: {
    readonly transport: Frond.Dep<typeof TradingBackendTransportNode>;
  };
  readonly result: OrdersResult;
  readonly actions: {
    readonly placeOrder: Frond.ActionContract<OrderInput, Order>;
  };
}>;

export class OrdersNode extends Frond.NodeBase<OrdersSpec> {
  static readonly spec = Frond.resourceSpec<OrdersSpec>({
    tag: Frond.tag("docs/orders"),
    key: () => Frond.Key.singleton(),
    dependencies: Frond.dependencies(() => ({
      transport: Frond.dep(TradingBackendTransportNode, Frond.Args.none),
    })),
    driver: Frond.Driver.Async<OrdersSpec>({
      acquire: Frond.Driver.Acquire(async (ctx) => {
        const orders = await ctx.deps.transport.client.orders.list();
        return new OrdersResult(orders);
      }),
      actions: {
        placeOrder: Frond.Driver.Action(async (ctx, input) => {
          const order = await ctx.deps.transport.client.orders.place(input);
          ctx.node.result.upsert(order);
          return order;
        }),
      },
    }),
  });
}
```

## Authoring Rules

- Use `type XSpec = Frond.NodeSpec<{ ... }>` as the single upfront carrier.
- Extend `Frond.NodeBase<XSpec>` directly.
- Put the descriptor on `static readonly spec = Frond.resourceSpec<XSpec>(...)`, `serviceSpec`, `nodeSpec`, or `facadeSpec`.
- Keep `Frond.Driver.Async<XSpec>` or `Frond.Driver.Effect<XSpec>`. This repetition is intentional for v0 because it anchors contextual typing for `ctx` and `input`.
- Use `Frond.Key.singleton()` and `Frond.Key.structure(...)`; do not return raw keys.
- Use `Frond.Dep<typeof Node>` for dependency carrier fields, and `Frond.dep(Node, args)` inside `Frond.dependencies(...)`.
- Use `Frond.Driver.Acquire`, `Refresh`, `Release`, `Live`, and `Action` wrappers for driver channels.
- Prefer inline `deps` and `actions` fields inside the carrier unless a type is reused outside the node.
- Prefer inline `actions` inside `driver.actions`; extract an action object only when reuse or readability clearly wins.
- Prefer inferred action `input` and driver `ctx` inside `Driver.Async<XSpec>` / `Driver.Effect<XSpec>`. Add annotations only when TypeScript cannot infer.
- Use `node.actions.*` from consumers. Add domain methods only when they add real domain semantics, not as pass-through wrappers.
- Keep computed/read-only domain getters on the node when they improve consumer readability.
- Use `ctx.refreshDep("name")` only when a parent driver intentionally refreshes a direct dependency. Runtime does not cascade refresh automatically.

## Avoid

- Generated-superclass authoring. Specs are static descriptors on exported node classes.
- Legacy root driver helper constructors. Use `Frond.Driver.Async` or `Frond.Driver.Effect`.
- Ready-node compatibility aliases in new authoring.
- Separate `XDeps`, `XActions`, or `XDriverContext` aliases that only mirror one node's carrier.
- Protected action bridge pass-through wrappers when `this.actions.name(input)` or consumer
  `node.actions.name(input)` already expresses the command.
- Moving driver implementation into `NodeSpec`; the carrier is contract, not implementation.

## Migration Workflow

1. Convert the carrier to `type XSpec = Frond.NodeSpec<{ args; key; deps; result; actions }>;`.
2. Convert the class to `class XNode extends Frond.NodeBase<XSpec>`.
3. Move the old descriptor into `static readonly spec`.
4. Use `Frond.Driver.Async<XSpec>` or `Frond.Driver.Effect<XSpec>`.
5. Wrap hooks and actions with `Frond.Driver.*`.
6. Replace dependency callbacks with `Frond.dependencies`.
7. Remove pass-through domain action methods and update consumers to `node.actions.*`.
8. Run the package typecheck first, then broader checks if public/core typing changed.

## Checks

Use these searches to find stale authoring:

```sh
rg "const .*NodeSpec = Frond\\.(resourceSpec|serviceSpec|nodeSpec|facadeSpec)<|extends .*NodeSpec"
rg "protected action\\(|this\\.actions\\.[^(]+\\("
```


Run `bun run typecheck` after broad migrations or public type surface changes.
