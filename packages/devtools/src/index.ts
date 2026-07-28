/**
 * Client half of the Frond devtools hub.
 *
 * Platform-free by construction: the transport is a global `WebSocket` carrying
 * ndjson, and nothing reachable from this entry point imports `node:` anything.
 * The same build attaches from a browser, from Bun, and from React Native.
 * Filesystem discovery lives in `@frondruntime/devtools/node`, kept behind its
 * own export so a browser bundler never has to resolve it.
 */
export { type AttachOptions, attachLayer, attachRuntime } from "./attach.ts";
export { attachDevtools, type DevtoolsOptions } from "./attachDevtools.ts";
export { createValueEncoder, encodeRecord, type ValueEncoder } from "./encode.ts";
export { type EncodePolicy, resolvePolicy } from "./policy.ts";
export * from "./protocol.ts";
export { encodeGraphSnapshot, type SnapshotRequest } from "./snapshot.ts";
