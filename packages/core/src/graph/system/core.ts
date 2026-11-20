import type { GraphJobQueue } from "../queue/jobQueue";
import type { CoreCall } from "../queue/reply";
import type { GraphSystemService } from "../types";
import type { GraphCommandsCore } from "./systemCommands";

export interface GraphSystemCore extends GraphCommandsCore {
  readonly jobs: GraphJobQueue;
  readonly snapshotSync: (
    context?: import("../types").ProjectionContext
  ) => import("../types").SystemSnapshot;
  readonly handleInputSync: () => void;
  readonly start: CoreCall<GraphSystemService["start"]>;
  readonly stop: CoreCall<GraphSystemService["stop"]>;
  readonly ensureNode: CoreCall<GraphSystemService["ensureNode"]>;
  readonly ensureReadyNodeById: CoreCall<GraphSystemService["ensureReadyNodeById"]>;
  readonly evictSubgraph: CoreCall<GraphSystemService["evictSubgraph"]>;
  readonly acquireNodeLiveLease: CoreCall<GraphSystemService["acquireNodeLiveLease"]>;
  readonly releaseNodeLiveLease: CoreCall<GraphSystemService["releaseNodeLiveLease"]>;
}

/** One in-memory graph: its Effect service and the callback core behind it. */
export interface GraphSystemInstance {
  readonly service: GraphSystemService;
  readonly core: GraphSystemCore;
}
