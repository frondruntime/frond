import { Effect } from "effect";
import type { RuntimeSignalAccess } from "../signals";
import { makeSpecOverrideMap } from "./planning/specOverrides";
import {
  type DriverOperationTimeoutMs,
  type DriverOperationTimeoutOptions,
  type DriverOperationTimeouts,
  GraphConfigInvalid,
  type GraphSystemOptions,
  type SpecOverride,
} from "./types";

export type GraphRuntimeSpanAttributes = Readonly<Record<string, string>>;

export interface NormalizedGraphSystemConfigBase {
  readonly runtimeSpanAttributes: GraphRuntimeSpanAttributes;
  readonly specOverrides: ReadonlyMap<unknown, unknown>;
  readonly driverTimeouts: DriverOperationTimeouts;
}

export interface NormalizedGraphSystemConfig extends NormalizedGraphSystemConfigBase {
  readonly signals: RuntimeSignalAccess;
}

const defaultDriverTimeouts = {
  acquire: 15_000,
  refresh: 15_000,
  action: 15_000,
  release: 5_000,
  live: 15_000,
} satisfies DriverOperationTimeouts;

const emptySpecOverrides: ReadonlyArray<SpecOverride> = [];

export const noopRuntimeSignalAccess: RuntimeSignalAccess = {
  publish: () => Effect.void,
  readRetained: () => Effect.succeed([]),
  subscribe: () =>
    Effect.succeed({
      unsubscribe: () => undefined,
    }),
};

export function normalizeGraphSystemConfigBase(
  options: GraphSystemOptions
): NormalizedGraphSystemConfigBase {
  return {
    runtimeSpanAttributes: { "frond.runtime.id": options.runtimeId },
    specOverrides: makeSpecOverrideMap(options.specOverrides ?? emptySpecOverrides),
    driverTimeouts: normalizeDriverTimeouts(options.driverTimeouts),
  };
}

export function normalizeGraphSystemOptions(
  options: GraphSystemOptions
): NormalizedGraphSystemConfig {
  return withGraphSignalAccess(
    normalizeGraphSystemConfigBase(options),
    options.signals ?? noopRuntimeSignalAccess
  );
}

export function withGraphSignalAccess(
  config: NormalizedGraphSystemConfigBase,
  signals: RuntimeSignalAccess
): NormalizedGraphSystemConfig {
  return { ...config, signals };
}

function normalizeDriverTimeouts(
  options: DriverOperationTimeoutOptions | undefined
): DriverOperationTimeouts {
  return {
    acquire: normalizeDriverTimeout("acquire", options?.acquire, defaultDriverTimeouts.acquire),
    refresh: normalizeDriverTimeout("refresh", options?.refresh, defaultDriverTimeouts.refresh),
    action: normalizeDriverTimeout("action", options?.action, defaultDriverTimeouts.action),
    release: normalizeDriverTimeout("release", options?.release, defaultDriverTimeouts.release),
    live: normalizeDriverTimeout("live", options?.live, defaultDriverTimeouts.live),
  };
}

function normalizeDriverTimeout(
  operation: keyof DriverOperationTimeouts,
  value: DriverOperationTimeoutMs | undefined,
  defaultValue: DriverOperationTimeoutMs
): DriverOperationTimeoutMs {
  if (value === undefined) {
    return defaultValue;
  }

  if (Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
    return value;
  }

  throw new GraphConfigInvalid({
    field: `driverTimeouts.${operation}`,
    cause: { timeout: value },
  });
}
