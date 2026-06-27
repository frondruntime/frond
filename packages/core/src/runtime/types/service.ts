import { Context, type Effect } from "effect";
import type { NodeRead, NodeRequest } from "../../graph";
import type {
  RuntimeSignal,
  RuntimeSignalSubscriber,
  RuntimeSignalSubscription,
} from "../../signals";
import type { RuntimeSnapshotPurpose, RuntimeWorkMetadata } from "../work";
import type { RuntimeCommand, RuntimeControl, RuntimeInput, RuntimeQuery } from "./commands";
import type { RuntimeEventRecord } from "./events";
import type { RuntimeError, RuntimeStatus } from "./ids";
import type { RuntimeQueryResult } from "./queries";
import type { RuntimeNodeSnapshotLookup } from "./reads";
import type { RuntimeSnapshot } from "./snapshots";
import type { RuntimeSubmission } from "./submissions";

export type RuntimeObserver = (record: RuntimeEventRecord) => void;

export interface RuntimeSubscription {
  readonly unsubscribe: () => void;
}

export interface RuntimeHostService {
  readonly resolveNodeIdSync: (request: NodeRequest) => NodeRead["nodeId"];
  readonly getStatusSync: () => RuntimeStatus;
  readonly readNodeSnapshotSync: (nodeId: NodeRead["nodeId"]) => RuntimeNodeSnapshotLookup<unknown>;
  readonly readNodeSnapshot: (
    nodeId: NodeRead["nodeId"]
  ) => Effect.Effect<RuntimeNodeSnapshotLookup<unknown>>;
  readonly submit: (command: RuntimeCommand) => Effect.Effect<RuntimeSubmission, RuntimeError>;
  readonly control: (control: RuntimeControl) => Effect.Effect<void, RuntimeError>;
  readonly query: (query: RuntimeQuery) => Effect.Effect<RuntimeQueryResult, RuntimeError>;
  readonly ingest: (input: RuntimeInput) => Effect.Effect<void, RuntimeError>;
  readonly publish: (
    signal: RuntimeSignal,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Effect.Effect<void, RuntimeError>;
  readonly subscribeSignals: (
    subscriber: RuntimeSignalSubscriber
  ) => Effect.Effect<RuntimeSignalSubscription, RuntimeError>;
  readonly getSnapshot: () => Effect.Effect<RuntimeSnapshot>;
  readonly getSnapshotFor: (purpose: RuntimeSnapshotPurpose) => Effect.Effect<RuntimeSnapshot>;
  readonly observe: (observer: RuntimeObserver) => Effect.Effect<RuntimeSubscription>;
}

export class FrondRuntime extends Context.Service<FrondRuntime, RuntimeHostService>()(
  "FrondRuntime"
) {}
