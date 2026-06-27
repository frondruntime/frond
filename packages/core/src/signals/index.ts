import type { Effect } from "effect";
import type { RuntimeId, RuntimeWorkContext } from "../runtime/types";

export type RuntimeSignalChannel = string & { readonly __brand: "Runtime.SignalChannel" };

export type RuntimeSignal = {
  readonly channel: RuntimeSignalChannel;
  readonly name: string;
  readonly payload: unknown;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type RuntimeSignalRecord = {
  readonly runtimeId: RuntimeId;
  readonly sequence: number;
  readonly recordedAt: number;
  readonly signal: RuntimeSignal;
};

export type RuntimeSignalPolicy =
  | {
      readonly retention: "none";
    }
  | {
      readonly retention: "bounded";
      readonly bufferSize?: number | undefined;
    };

export interface RuntimeSignalChannelDefinition {
  readonly name: string;
  readonly channel: RuntimeSignalChannel;
  readonly policy: RuntimeSignalPolicy;
  readonly signal: (
    name: string,
    payload?: unknown,
    metadata?: Readonly<Record<string, unknown>> | undefined
  ) => RuntimeSignal;
}

export type RuntimeSignalQuery = {
  readonly channel?: RuntimeSignalChannel | undefined;
  readonly limit?: number | undefined;
};

export interface RuntimeSignalSubscription {
  readonly unsubscribe: () => void;
}

export interface RuntimeSignalSubscriber {
  readonly name: string;
  readonly channels?: ReadonlyArray<RuntimeSignalChannel> | undefined;
  readonly handle: (record: RuntimeSignalRecord) => Effect.Effect<void, unknown>;
}

export interface RuntimeSignalAccess {
  readonly publish: (
    signal: RuntimeSignal,
    work?: RuntimeWorkContext | undefined
  ) => Effect.Effect<void>;
  readonly readRetained: (
    query?: RuntimeSignalQuery | undefined
  ) => Effect.Effect<ReadonlyArray<RuntimeSignalRecord>>;
  readonly subscribe: (
    subscriber: RuntimeSignalSubscriber
  ) => Effect.Effect<RuntimeSignalSubscription>;
}

/**
 * Brands a runtime signal channel name.
 *
 * Use for ad hoc channels when retention policy is configured elsewhere. Prefer
 * `defineChannel` when the channel and policy should travel together.
 */
export const channel = (channel: string): RuntimeSignalChannel => channel as RuntimeSignalChannel;

/**
 * Defines a signal channel with its retention policy and signal factory.
 *
 * Runtime options can register the returned definition so publishing code does
 * not carry retention configuration around separately.
 */
export const defineChannel = (input: {
  readonly name: string;
  readonly policy: RuntimeSignalPolicy;
}): RuntimeSignalChannelDefinition => {
  const signalChannel = channel(input.name);

  return {
    name: input.name,
    channel: signalChannel,
    policy: input.policy,
    signal: (
      name: string,
      payload?: unknown,
      metadata?: Readonly<Record<string, unknown>> | undefined
    ) =>
      signal({
        channel: signalChannel,
        name,
        payload,
        metadata,
      }),
  };
};

/**
 * Creates a runtime signal record payload.
 *
 * Signals are best-effort runtime messages. Publish them for domain events,
 * diagnostics, or adapter communication; do not use them as graph dependencies.
 */
export const signal = (input: {
  readonly channel: string | RuntimeSignalChannel;
  readonly name: string;
  readonly payload?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): RuntimeSignal => ({
  channel: input.channel as RuntimeSignalChannel,
  name: input.name,
  payload: input.payload,
  metadata: input.metadata,
});

export const Signals = {
  channel,
  defineChannel,
  signal,
} as const;
