import type { RuntimeSignalRecord } from "../../signals";
import type { RuntimeEventRecord } from "./events";
import type { RuntimeId, RuntimeStatus } from "./ids";

export type RuntimeQueryResult =
  | {
      readonly _tag: "RuntimeStatus";
      readonly runtimeId: RuntimeId;
      readonly status: RuntimeStatus;
      readonly inputIngestionEnabled: boolean;
    }
  | {
      readonly _tag: "RuntimeEvents";
      readonly runtimeId: RuntimeId;
      readonly events: ReadonlyArray<RuntimeEventRecord>;
    }
  | {
      readonly _tag: "RuntimeSinks";
      readonly sinks: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "RuntimeSignals";
      readonly runtimeId: RuntimeId;
      readonly records: ReadonlyArray<RuntimeSignalRecord>;
    }
  | {
      readonly _tag: "RuntimeSignalSubscribers";
      readonly subscribers: ReadonlyArray<string>;
    };
