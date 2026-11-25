import type * as Frond from "@frondruntime/core";
import { Key } from "@frondruntime/core";

export function getReactArgsFingerprint(value: unknown): string {
  return `canonical:${Key.canonicalArgs(value)}`;
}

/**
 * Resolves a node id without validating the request's args again: the caller
 * already canonicalized them, through `getReactArgsFingerprint`.
 */
export type ValidatedNodeIdResolver = (request: Frond.Graph.NodeRequest) => Frond.Graph.NodeId;

/** Validated resolvers need canonical args first; wrappers keep their public validation order. */
export function resolveReactNodeIdentity(
  runtime: Pick<Frond.Runtime.Runtime, "resolveNodeIdSync">,
  request: Frond.Graph.NodeRequest,
  resolveValidated: ValidatedNodeIdResolver | undefined
): { readonly nodeId: Frond.Graph.NodeId; readonly argsFingerprint: string } {
  const { args } = request;
  if (resolveValidated === undefined) {
    const nodeId = runtime.resolveNodeIdSync(request);
    return { nodeId, argsFingerprint: getReactArgsFingerprint(args) };
  }

  const argsFingerprint = getReactArgsFingerprint(args);
  return { nodeId: resolveValidated(request), argsFingerprint };
}

// Core's `resolveValidatedNodeIdSlot` (`runtime/core.ts`): a runtime built by
// `createRuntime` owns it, non-enumerable. It is not a package export.
const resolveValidatedNodeIdSlot = Symbol.for("frond.runtime.resolveValidatedNodeIdSync");

/**
 * Returns the runtime's own validated resolver, or `undefined` for a wrapper
 * or test double, which keeps its own `resolveNodeIdSync`.
 *
 * With a resolver, a render canonicalizes args once: the fingerprint validates
 * them first, so an args error still comes before any spec or key work, as it
 * does from `resolveNodeIdSync`; then the resolver skips the second pass.
 */
export function validatedNodeIdResolver(runtime: object): ValidatedNodeIdResolver | undefined {
  if (!Object.prototype.hasOwnProperty.call(runtime, resolveValidatedNodeIdSlot)) {
    return undefined;
  }

  const slot = (
    runtime as {
      readonly [resolveValidatedNodeIdSlot]: {
        readonly owner: object;
        readonly resolve: ValidatedNodeIdResolver;
      };
    }
  )[resolveValidatedNodeIdSlot];
  return slot.owner === runtime ? slot.resolve : undefined;
}
