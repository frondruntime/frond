export { Context, Deferred, Effect } from "effect";
export { Driver, Key, unwrapEffect, wrapPromise } from "../src";
export {
  AcquireFailed,
  ActionFailed,
  CycleDetected,
  DependencyDefinitionFailed,
  DependencyDefinitionFailures,
  DependencyFailed,
  DependencyFailures,
  DependencyRefreshFailed,
  DisposerFailed,
  DisposerTimedOut,
  DriverOperationTimedOut,
  DriverPromiseFailed,
  DuplicateNodeTag,
  EffectBoundaryFailed,
  GraphConfigInvalid,
  GraphInvariantViolation,
  KeyBuildFailed,
  LiveDeliveryFailed,
  NodeConstructionFailed,
  NodeEvicted,
  RefreshFailed,
  ReleaseFailed,
  resultCommit,
  SpecOverrideFailed,
  UpdateNodeArgsFailed,
} from "../src/graph";
export { KeyNonFiniteNumberError } from "../src/keys";
export type { ActionContract, Dep, NodeSpec } from "../src/node";
export { dep, dependencies, NodeBase, resourceSpec, serviceSpec } from "../src/node";
export { createRuntime, createRuntimeClient } from "../src/runtime";
export { FrondRuntimeEffect } from "../src/runtime/live";

import { Effect } from "effect";
import { Driver, Key } from "../src";
import { makeInMemoryGraphSystem as makeSourceGraphSystem } from "../src/graph/system";
import type { GraphSystemOptions, GraphSystemService } from "../src/graph/types";
import type { ActionContract, Dep, NodeSpec } from "../src/node";
import { dep, dependencies, NodeBase, resourceSpec, serviceSpec } from "../src/node";

export function makeInMemoryGraphSystem(
  options: Partial<GraphSystemOptions> = {}
): GraphSystemService {
  return makeSourceGraphSystem({
    ...options,
    runtimeId: options.runtimeId ?? "mock-test-runtime",
  });
}

type TransportNodeSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

export class TransportNode extends NodeBase<TransportNodeSpec, "effect"> {
  static readonly spec = serviceSpec.effect<TransportNodeSpec>({
    tag: "services/transport",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed("transport")),
  });
}

type ProfileNodeSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly transport: Dep<typeof TransportNode>;
  };
  readonly result: string;
}>;

export class ProfileNode extends NodeBase<ProfileNodeSpec, "effect"> {
  static readonly spec = resourceSpec.effect<ProfileNodeSpec>({
    tag: "resources/profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      transport: dep(TransportNode, {}),
    })),
    acquire: Driver.Acquire((ctx) => Effect.succeed(`profile:${ctx.deps.transport.result}`)),
  });
}

export type MutableProfile = {
  readonly name: string;
  timezone: string;
};

type ActionProfileNodeSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly transport: Dep<typeof TransportNode>;
  };
  readonly result: MutableProfile;
  readonly actions: {
    readonly updateTimezone: ActionContract<
      { readonly timezone: string },
      { readonly timezone: string }
    >;
    readonly failTimezone: ActionContract<void, never>;
  };
}>;

export class ActionProfileNode extends NodeBase<ActionProfileNodeSpec, "effect"> {
  static readonly spec = resourceSpec.effect<ActionProfileNodeSpec>({
    tag: "resources/action-profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      transport: dep(TransportNode, {}),
    })),
    acquire: Driver.Acquire((ctx) =>
      Effect.succeed({ name: ctx.deps.transport.result, timezone: "UTC" })
    ),
    refresh: Driver.Refresh((ctx) =>
      Effect.gen(function* () {
        yield* ctx.patchResult((current) => {
          current.timezone = "REFRESHED";
        });
      })
    ),
    actions: {
      updateTimezone: Driver.Action((ctx, input) =>
        Effect.gen(function* () {
          yield* ctx.patchResult((current) => {
            current.timezone = input.timezone;
          });

          return yield* Effect.promise(async () => ({ timezone: input.timezone }));
        })
      ),
      failTimezone: Driver.Action(() => Effect.fail({ _tag: "TimezoneRejected" })),
    },
  });
}
