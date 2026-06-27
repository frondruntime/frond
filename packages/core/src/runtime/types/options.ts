import type { Effect } from "effect";
import type { SpecOverride } from "../../graph/types/operations";
import type { DriverOperationTimeoutOptions } from "../../graph/types/service";
import type {
  RuntimeSignalChannelDefinition,
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
  readonly handle: (record: RuntimeEventRecord) => Effect.Effect<void, unknown>;
}

export interface RuntimeOptions {
  readonly runtimeId?: RuntimeId | undefined;
  readonly sinks?: ReadonlyArray<RuntimeSink> | undefined;
  readonly eventBufferSize?: number | undefined;
  readonly inputIngestionEnabled?: boolean | undefined;
  readonly specOverrides?: ReadonlyArray<SpecOverride> | undefined;
  readonly driverTimeouts?: DriverOperationTimeoutOptions | undefined;
  readonly channels?: ReadonlyArray<RuntimeSignalChannelDefinition> | undefined;
  readonly signalSubscribers?: ReadonlyArray<RuntimeSignalSubscriber> | undefined;
  readonly signalPolicies?: Readonly<Record<string, RuntimeSignalPolicy>> | undefined;
  readonly syncClock?: RuntimeSyncClock | undefined;
}
