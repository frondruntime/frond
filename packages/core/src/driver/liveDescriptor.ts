import type { Effect } from "effect";
import type { ActiveNodeLiveDemandSnapshot, LiveResourceStopReason } from "../graph/types";

export type { ActiveNodeLiveDemandSnapshot, LiveResourceStopReason } from "../graph/types";

declare const liveResourceMode: unique symbol;

type AsyncLiveResourceResult<TResource> =
  TResource extends Effect.Effect<unknown, unknown, unknown>
    ? never
    : TResource | Promise<TResource>;

export interface AsyncLiveContext<TNode extends object> {
  readonly node: TNode;
  readonly signal: AbortSignal;
}

export interface AsyncLiveStopContext<TNode extends object> extends AsyncLiveContext<TNode> {
  readonly reason: LiveResourceStopReason;
}

export interface LiveContext<TNode extends object> {
  readonly node: TNode;
  readonly signal: AbortSignal;
}

export interface LiveStopContext<TNode extends object> extends LiveContext<TNode> {
  readonly reason: LiveResourceStopReason;
}

/**
 * Promise-facing live-resource lifecycle.
 *
 * Runtime owns demand transitions. The resource owns start/update/stop work and
 * returns one opaque resource value that Frond passes back on later transitions.
 */
export interface AsyncLiveResource<TNode extends object, TResource> {
  readonly start: (
    ctx: AsyncLiveContext<TNode>,
    demand: ActiveNodeLiveDemandSnapshot
  ) => AsyncLiveResourceResult<TResource>;
  readonly update?: {
    bivarianceHack(
      ctx: AsyncLiveContext<TNode>,
      resource: TResource,
      demand: ActiveNodeLiveDemandSnapshot
    ): void | Promise<void>;
  }["bivarianceHack"];
  readonly stop: {
    bivarianceHack(ctx: AsyncLiveStopContext<TNode>, resource: TResource): void | Promise<void>;
  }["bivarianceHack"];
}

/**
 * Effect-native live-resource lifecycle.
 *
 * Use this with `Driver.Effect` when live setup, updates, or cleanup need Effect
 * requirements, typed failures, or interruption semantics.
 */
export interface EffectLiveResource<TNode extends object, TResource, R = never> {
  readonly start: (
    ctx: LiveContext<TNode>,
    demand: ActiveNodeLiveDemandSnapshot
  ) => Effect.Effect<TResource, unknown, R>;
  readonly update?: {
    bivarianceHack(
      ctx: LiveContext<TNode>,
      resource: TResource,
      demand: ActiveNodeLiveDemandSnapshot
    ): Effect.Effect<void, unknown, R>;
  }["bivarianceHack"];
  readonly stop: {
    bivarianceHack(
      ctx: LiveStopContext<TNode>,
      resource: TResource
    ): Effect.Effect<void, unknown, R>;
  }["bivarianceHack"];
}

export type AsyncLiveResourceDescriptor<TNode extends object, TResource> = AsyncLiveResource<
  TNode,
  TResource
> & {
  readonly [liveResourceMode]: "async";
};

export type EffectLiveResourceDescriptor<
  TNode extends object,
  TResource,
  R = never,
> = EffectLiveResource<TNode, TResource, R> & {
  readonly [liveResourceMode]: "effect";
};

export function createLiveDescriptor<TNode extends object, TResource, R = never>(
  resource: EffectLiveResource<TNode, TResource, R>
): EffectLiveResourceDescriptor<TNode, TResource, R>;
export function createLiveDescriptor<TNode extends object, TResource>(
  resource: AsyncLiveResource<TNode, TResource>
): AsyncLiveResourceDescriptor<TNode, TResource>;
export function createLiveDescriptor(resource: object): object {
  return resource;
}
