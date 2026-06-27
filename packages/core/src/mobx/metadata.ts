import type { RuntimeWorkMetadata } from "../runtime";

// These metadata values are immutable and read on every readiness/action/refresh/
// release/eviction cycle, so share one frozen instance each instead of allocating
// a fresh object per call.
const readinessMetadata: RuntimeWorkMetadata = Object.freeze({
  source: "mobx",
  reason: "readiness",
  priority: "visible",
});

const actionMetadata: RuntimeWorkMetadata = Object.freeze({
  source: "mobx",
  reason: "action",
  priority: "visible",
});

const refreshMetadata: RuntimeWorkMetadata = Object.freeze({
  source: "mobx",
  reason: "refresh",
  priority: "background",
});

const releaseMetadata: RuntimeWorkMetadata = Object.freeze({
  source: "mobx",
  reason: "release",
  priority: "background",
});

const evictionMetadata: RuntimeWorkMetadata = Object.freeze({
  source: "mobx",
  reason: "eviction",
  priority: "blocking",
});

export const mobxRuntimeMetadata = {
  readiness: (): RuntimeWorkMetadata => readinessMetadata,
  action: (): RuntimeWorkMetadata => actionMetadata,
  refresh: (): RuntimeWorkMetadata => refreshMetadata,
  release: (): RuntimeWorkMetadata => releaseMetadata,
  eviction: (): RuntimeWorkMetadata => evictionMetadata,
} as const;
