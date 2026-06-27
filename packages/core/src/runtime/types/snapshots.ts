import type { SystemSnapshot } from "../../graph/types/reads";
import type { RuntimeSignalRecord } from "../../signals";
import type { RuntimeEventRecord } from "./events";
import type { RuntimeId, RuntimeStatus } from "./ids";

export interface RuntimeSnapshot {
  readonly runtimeId: RuntimeId;
  readonly status: RuntimeStatus;
  readonly inputIngestionEnabled: boolean;
  readonly events: ReadonlyArray<RuntimeEventRecord>;
  readonly sinks: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<RuntimeSignalRecord>;
  readonly signalSubscribers: ReadonlyArray<string>;
  readonly graph: SystemSnapshot;
}
