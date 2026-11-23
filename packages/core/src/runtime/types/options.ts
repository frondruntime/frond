import type { Effect } from "effect";
import type { SpecOverride } from "../../graph/types/operations";
import type { DriverOperationTimeoutOptions } from "../../graph/types/service";
import type {
  RuntimeSignalChannelRegistration,
  RuntimeSignalPolicy,
  RuntimeSignalSubscriber,
} from "../../signals";
import type { RuntimeEventRecord } from "./events";
import type { RuntimeId } from "./ids";

export interface RuntimeSyncClock {
  readonly now: () => number;
}

export interface RuntimeSink {
  readonly name: string;
  /**
   * Sink delivery is deterministic and inline: runtime submissions await this
   * Effect before they settle. Keep handlers quick, or fork internal work when
   * exporting to slow transports.
   */
  readonly handle: (record: RuntimeEventRecord) => Effect.Effect<void, unknown>;
}

export interface RuntimeOptions {
  readonly runtimeId?: RuntimeId | undefined;
  readonly sinks?: ReadonlyArray<RuntimeSink> | undefined;
  /**
   * How many recent events the runtime keeps for `events()`, the
   * `RuntimeEvents` query and snapshots. Required, with no default: each app
   * decides for its own build. Observers and sinks see every event either way.
   * Pass 0 in production unless devtools are attached there; devtools
   * snapshots need retained events for their `sequence`. For example:
   * `eventBufferSize: import.meta.env.DEV ? 512 : 0`.
   */
  readonly eventBufferSize: number;
  /**
   * Enables committed-result freezing, the dependency re-plan check, and the
   * React observer check. Required, with no default: each app decides for its
   * own build. Pass false in production. For example:
   * `development: import.meta.env.DEV` (React Native: `development: __DEV__`).
   */
  readonly development: boolean;
  readonly inputIngestionEnabled?: boolean | undefined;
  readonly specOverrides?: ReadonlyArray<SpecOverride> | undefined;
  readonly driverTimeouts?: DriverOperationTimeoutOptions | undefined;
  /**
   * Channels to install at boot, as registrations rather than full definitions:
   * the list is heterogeneous by nature, and only a channel's name and policy are
   * read here. See {@link RuntimeSignalChannelRegistration}.
   */
  readonly channels?: ReadonlyArray<RuntimeSignalChannelRegistration> | undefined;
  readonly signalSubscribers?: ReadonlyArray<RuntimeSignalSubscriber> | undefined;
  readonly signalPolicies?: Readonly<Record<string, RuntimeSignalPolicy>> | undefined;
  readonly syncClock?: RuntimeSyncClock | undefined;
}
