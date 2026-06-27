import type { GraphNodeCell } from "../planning/plan";
import {
  ActionFailed,
  type ActionRequest,
  type ActionResult,
  GraphInvariantViolation,
  type NodeRead,
  RefreshFailed,
  type RefreshRequest,
  type RefreshResult,
  UnsafeUpdateNodeFailed,
  type UnsafeUpdateNodeRequest,
  type UnsafeUpdateNodeResult,
  UpdateNodeArgsFailed,
  type UpdateNodeArgsRequest,
  type UpdateNodeArgsResult,
} from "../types";

export function makeActionFailure(
  cell: GraphNodeCell,
  request: ActionRequest,
  cause: unknown
): Extract<ActionResult, { readonly _tag: "Failure" }> {
  return {
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new ActionFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      action: request.action,
      input: request.input,
      cause,
    }),
  };
}

export function makeMissingNodeActionFailure(
  nodeId: NodeRead["nodeId"],
  request: ActionRequest
): Extract<ActionResult, { readonly _tag: "Failure" }> {
  return {
    _tag: "Failure",
    nodeId,
    error: new ActionFailed({
      nodeId,
      tag: "unknown",
      action: request.action,
      input: request.input,
      cause: missingNodeCellInvariant(nodeId),
    }),
  };
}

export function makeRefreshFailure(
  cell: GraphNodeCell,
  _request: RefreshRequest,
  cause: unknown
): Extract<RefreshResult, { readonly _tag: "Failure" }> {
  return {
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new RefreshFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause,
    }),
  };
}

export function makeMissingNodeRefreshFailure(
  nodeId: NodeRead["nodeId"],
  _request: RefreshRequest
): Extract<RefreshResult, { readonly _tag: "Failure" }> {
  return {
    _tag: "Failure",
    nodeId,
    error: new RefreshFailed({
      nodeId,
      tag: "unknown",
      cause: missingNodeCellInvariant(nodeId),
    }),
  };
}

export function makeUpdateArgsFailure(
  cell: GraphNodeCell,
  _request: UpdateNodeArgsRequest,
  cause: unknown
): Extract<UpdateNodeArgsResult, { readonly _tag: "Failure" }> {
  return {
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new UpdateNodeArgsFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause,
    }),
  };
}

export function makeMissingNodeUpdateArgsFailure(
  nodeId: NodeRead["nodeId"],
  _request: UpdateNodeArgsRequest,
  cause: unknown = missingNodeCellInvariant(nodeId)
): Extract<UpdateNodeArgsResult, { readonly _tag: "Failure" }> {
  return {
    _tag: "Failure",
    nodeId,
    error: new UpdateNodeArgsFailed({
      nodeId,
      tag: "unknown",
      cause,
    }),
  };
}

export function makeUnsafeUpdateNodeFailure(
  cell: GraphNodeCell,
  request: UnsafeUpdateNodeRequest,
  cause: unknown
): UnsafeUpdateNodeResult {
  return {
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new UnsafeUpdateNodeFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      label: request.label,
      cause,
    }),
  };
}

export function makeMissingUnsafeUpdateNodeFailure(
  nodeId: NodeRead["nodeId"],
  request: UnsafeUpdateNodeRequest,
  cause: unknown = missingNodeCellInvariant(nodeId)
): UnsafeUpdateNodeResult {
  return {
    _tag: "Failure",
    nodeId,
    error: new UnsafeUpdateNodeFailed({
      nodeId,
      tag: "unknown",
      label: request.label,
      cause,
    }),
  };
}

function missingNodeCellInvariant(nodeId: NodeRead["nodeId"]): GraphInvariantViolation {
  return new GraphInvariantViolation({
    nodeId,
    tag: "unknown",
    invariant: "node cell must exist before graph operation submission",
  });
}
