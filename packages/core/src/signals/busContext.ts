import { Context, type Effect } from "effect";
import type { RuntimeSignalAccess, RuntimeSignalQuery, RuntimeSignalRecord } from "./index";

export interface RuntimeSignalBusService extends RuntimeSignalAccess {
  readonly records: (
    query?: RuntimeSignalQuery | undefined
  ) => Effect.Effect<ReadonlyArray<RuntimeSignalRecord>>;
  readonly subscribers: () => Effect.Effect<ReadonlyArray<string>>;
}

export class RuntimeSignalBus extends Context.Service<RuntimeSignalBus, RuntimeSignalBusService>()(
  "RuntimeSignalBus"
) {}
