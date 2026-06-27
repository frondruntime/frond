import type * as Frond from "@frondruntime/core";

export const ReactRuntimeMetadata = {
  readiness: (): Frond.Runtime.RuntimeWorkMetadata => ({
    source: "react",
    reason: "readiness",
    priority: "visible",
  }),
  retry: (): Frond.Runtime.RuntimeWorkMetadata => ({
    source: "react",
    reason: "retry",
    priority: "visible",
  }),
  action: (): Frond.Runtime.RuntimeWorkMetadata => ({
    source: "react",
    reason: "action",
    priority: "visible",
  }),
  refresh: (): Frond.Runtime.RuntimeWorkMetadata => ({
    source: "react",
    reason: "refresh",
    priority: "background",
  }),
  argsUpdate: (): Frond.Runtime.RuntimeWorkMetadata => ({
    source: "react",
    reason: "args-update",
    priority: "visible",
  }),
  release: (): Frond.Runtime.RuntimeWorkMetadata => ({
    source: "react",
    reason: "release",
    priority: "background",
  }),
  eviction: (): Frond.Runtime.RuntimeWorkMetadata => ({
    source: "react",
    reason: "eviction",
    priority: "blocking",
  }),
} as const;
