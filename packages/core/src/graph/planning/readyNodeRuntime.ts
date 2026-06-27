import { asRuntimeReadyNodeControl } from "../../node";

export function updateReadyNodeRuntimeState(input: {
  readonly node: object;
  readonly args?: unknown | undefined;
  readonly deps?: object | undefined;
  readonly result?: unknown | undefined;
}): void {
  asRuntimeReadyNodeControl<unknown, object, unknown>(input.node)?._updateRuntimeReadyState(input);
}

export function closeReadyNode(node: object | undefined): void {
  asRuntimeReadyNodeControl<unknown, object, unknown>(node)?._closeRuntimeNode();
}
