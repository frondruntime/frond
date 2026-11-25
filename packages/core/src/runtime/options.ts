import {
  type NormalizedGraphSystemConfigBase,
  normalizeGraphSystemConfigBase,
} from "../graph/config";
import type { GraphSystemOptions } from "../graph/types";
import type {
  RuntimeSignalChannelRegistration,
  RuntimeSignalPolicy,
  RuntimeSignalSubscriber,
} from "../signals";
import { FrondRuntimeInvariantViolation } from "./errors";
import { nonNegativeInteger, nonNegativeIntegerWithDefault } from "./limits";
import { makeRuntimeId } from "./observability";
import type { RuntimeId, RuntimeOptions, RuntimeSink, RuntimeSyncClock } from "./types";

export type NormalizedRuntimeSignalPolicy =
  | {
      readonly retention: "none";
    }
  | {
      readonly retention: "bounded";
      readonly bufferSize: number;
    };

export interface RuntimeSignalPolicyRegistry {
  readonly defaultPolicy: NormalizedRuntimeSignalPolicy;
  readonly byChannel: Readonly<Record<string, NormalizedRuntimeSignalPolicy>>;
}

export interface NormalizedRuntimeConfig {
  readonly development: boolean;
  readonly runtimeId: RuntimeId;
  readonly syncClock: RuntimeSyncClock;
  readonly inputIngestionEnabled: boolean;
  readonly eventBus: {
    readonly runtimeId: RuntimeId;
    readonly eventBufferSize: number;
    readonly sinks: ReadonlyArray<RuntimeSink>;
  };
  readonly signalBus: {
    readonly runtimeId: RuntimeId;
    readonly policies: RuntimeSignalPolicyRegistry;
    readonly subscribers: ReadonlyArray<RuntimeSignalSubscriber>;
  };
  readonly graphConfig: NormalizedGraphSystemConfigBase;
}

const defaultSignalBufferSize = 128;

export function normalizeRuntimeOptions(options: RuntimeOptions): NormalizedRuntimeConfig {
  // Untyped callers receive the same invariant error for missing options
  // and invalid containers, before any property is read.
  if (typeof options !== "object" || options === null) {
    throw new FrondRuntimeInvariantViolation({
      message: "Frond runtime options are required: pass eventBufferSize and development.",
      cause: { options },
    });
  }

  if (typeof options.development !== "boolean") {
    throw new FrondRuntimeInvariantViolation({
      message: "Frond runtime development must be a boolean.",
      cause: { development: options.development },
    });
  }

  const runtimeId = options.runtimeId ?? makeRuntimeId();
  const syncClock = normalizeRuntimeSyncClock(options.syncClock);

  return {
    development: options.development,
    runtimeId,
    syncClock,
    inputIngestionEnabled: options.inputIngestionEnabled ?? true,
    eventBus: {
      runtimeId,
      eventBufferSize: eventBufferSizeLimit(options.eventBufferSize),
      sinks: [...(options.sinks ?? [])],
    },
    signalBus: {
      runtimeId,
      policies: normalizeRuntimeSignalPolicies({
        channels: options.channels ?? [],
        policies: options.signalPolicies ?? {},
      }),
      subscribers: [...(options.signalSubscribers ?? [])],
    },
    graphConfig: normalizeGraphSystemConfigBase({
      ...runtimeOwnedGraphOptions(runtimeId, options),
      syncClock,
    }),
  };
}

function runtimeOwnedGraphOptions(
  runtimeId: RuntimeId,
  options: RuntimeOptions
): GraphSystemOptions {
  return {
    runtimeId,
    development: options.development,
    specOverrides: options.specOverrides,
    driverTimeouts: options.driverTimeouts,
  };
}

function normalizeRuntimeSyncClock(clock: RuntimeSyncClock | undefined): RuntimeSyncClock {
  const source = clock ?? { now: Date.now };

  if (typeof source.now !== "function") {
    throw new FrondRuntimeInvariantViolation({
      message: "Frond runtime syncClock.now must be a function.",
      cause: { syncClock: source },
    });
  }

  return {
    now: () => {
      const now = source.now();

      if (!Number.isFinite(now)) {
        throw new FrondRuntimeInvariantViolation({
          message: "Frond runtime syncClock.now must return a finite number.",
          cause: { now },
        });
      }

      return now;
    },
  };
}

function eventBufferSizeLimit(limit: number): number {
  return nonNegativeInteger({ value: limit, label: "Runtime event buffer size", cause: { limit } });
}

function normalizeRuntimeSignalPolicies(input: {
  readonly channels: ReadonlyArray<RuntimeSignalChannelRegistration>;
  readonly policies: Readonly<Record<string, RuntimeSignalPolicy>>;
}): RuntimeSignalPolicyRegistry {
  const channelPolicies = signalPoliciesFromChannels(input.channels);
  assertNoSignalPolicyCollisions(channelPolicies, input.policies);
  const policies = {
    ...channelPolicies,
    ...input.policies,
  };

  return {
    defaultPolicy: { retention: "bounded", bufferSize: defaultSignalBufferSize },
    byChannel: Object.fromEntries(
      Object.entries(policies).map(([channel, policy]) => [
        channel,
        normalizeRuntimeSignalPolicy(channel, policy),
      ])
    ),
  };
}

function signalPoliciesFromChannels(
  channels: ReadonlyArray<RuntimeSignalChannelRegistration>
): Readonly<Record<string, RuntimeSignalPolicy>> {
  const policies: Record<string, RuntimeSignalPolicy> = {};

  for (const channelDefinition of channels) {
    // Own-property test, not a bare lookup: a channel named for an
    // `Object.prototype` member reads back as the inherited one and would
    // report a collision against nothing.
    if (Object.prototype.hasOwnProperty.call(policies, channelDefinition.channel)) {
      throw new FrondRuntimeInvariantViolation({
        message: "Frond runtime channel definitions must be unique by channel.",
        cause: { channel: channelDefinition.channel },
      });
    }

    policies[channelDefinition.channel] = channelDefinition.policy;
  }

  return policies;
}

function assertNoSignalPolicyCollisions(
  channels: Readonly<Record<string, RuntimeSignalPolicy>>,
  policies: Readonly<Record<string, RuntimeSignalPolicy>>
): void {
  for (const channel of Object.keys(policies)) {
    if (Object.prototype.hasOwnProperty.call(channels, channel)) {
      throw new FrondRuntimeInvariantViolation({
        message:
          "Frond runtime signalPolicies must not redefine a channel installed through channels.",
        cause: { channel },
      });
    }
  }
}

function normalizeRuntimeSignalPolicy(
  channel: string,
  policy: RuntimeSignalPolicy
): NormalizedRuntimeSignalPolicy {
  if (policy.retention === "none") {
    return { retention: "none" };
  }

  return {
    retention: "bounded",
    bufferSize: nonNegativeIntegerWithDefault({
      value: policy.bufferSize,
      defaultValue: defaultSignalBufferSize,
      label: "Runtime signal buffer size",
      cause: { channel, bufferSize: policy.bufferSize },
    }),
  };
}
