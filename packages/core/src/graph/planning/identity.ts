import { isKeyError } from "../../keys";
import type { GraphPlanState } from "../cell/cellModel";
import { KeyBuildFailed, type NodeId, type NodeKey, type NodeRequest } from "../types";
import { canonicalKey } from "./canonicalKey";
import { getNodeDescriptor, type NodeDescriptor } from "./descriptor";
import { type GraphOutcome, graphFailure, graphSuccess } from "./outcome";
import { applySpecOverride } from "./specOverrides";

export function makeNodeId(tag: string, key: NodeKey): NodeId {
  return `${tag}:${key}` as NodeId;
}

export interface ResolvedNodeIdentity {
  readonly request: NodeRequest;
  readonly descriptor: NodeDescriptor;
  readonly key: NodeKey;
  readonly nodeId: NodeId;
  readonly keyResult: GraphOutcome<NodeKey, KeyResolutionFailure>;
  readonly duplicateTag: boolean;
}

export type KeyResolutionFailure = {
  readonly key: NodeKey;
  readonly failure: KeyBuildFailed;
};

export function resolveEffectiveNodeId(state: GraphPlanState, request: NodeRequest): NodeId {
  return resolveNodeId(applySpecOverride(state.specOverrides, request));
}

export function resolveNodeIdentity(
  state: GraphPlanState,
  originalRequest: NodeRequest
): ResolvedNodeIdentity {
  const request = applySpecOverride(state.specOverrides, originalRequest);
  const descriptor = getNodeDescriptor(request.spec);
  const keyResult = resolveKey(descriptor, request);
  const key = keyResult._tag === "Success" ? keyResult.value : keyResult.failure.key;
  const nodeId = makeNodeId(descriptor.tag, key);
  const duplicateTag = duplicateTagSpec(state, descriptor.tag, request.spec);

  return { request, descriptor, key, nodeId, keyResult, duplicateTag };
}

function resolveNodeId(request: NodeRequest): NodeId {
  const descriptor = getNodeDescriptor(request.spec);
  const keyResult = resolveKey(descriptor, request);
  const key = keyResult._tag === "Success" ? keyResult.value : keyResult.failure.key;

  return makeNodeId(descriptor.tag, key);
}

function resolveKey(
  descriptor: NodeDescriptor,
  request: NodeRequest
): GraphOutcome<NodeKey, KeyResolutionFailure> {
  try {
    return graphSuccess(canonicalKey(descriptor.key(request.args)));
  } catch (cause) {
    const key = invalidKey(cause);
    const nodeId = makeNodeId(descriptor.tag, key);

    return graphFailure({
      key,
      failure: new KeyBuildFailed({
        nodeId,
        tag: descriptor.tag,
        cause,
      }),
    });
  }
}

function invalidKey(cause: unknown): NodeKey {
  return `__invalid__:${stableFailureLabel(cause)}` as NodeKey;
}

function stableFailureLabel(cause: unknown): string {
  const raw = isKeyError(cause)
    ? "path" in cause
      ? `${cause._tag}:${cause.path}`
      : cause._tag
    : cause instanceof Error
      ? cause.name
      : typeof cause;

  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 180);
}

function duplicateTagSpec(state: GraphPlanState, tag: string, spec: unknown): boolean {
  const existing = state.specByTag.get(tag);

  return existing !== undefined && existing !== spec;
}
