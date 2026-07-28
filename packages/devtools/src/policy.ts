import type { ValuePolicy } from "./protocol.ts";

/**
 * What this encoder can produce. All three policies are implemented.
 *
 * `"full"` is a stub in the sense that it has no per-field allowlist and no
 * redaction — it sends what it finds. It is not a stub in its bounds: cycles,
 * depth, and breadth are enforced, because those three are not polish. A cyclic
 * or unboundedly deep graph result would hang the observed app inside its own
 * devtools, on its own event loop.
 *
 * What those bounds are not is a size budget. This socket is loopback and the
 * eventual reader is an agent's context window, so the scarce resource is the
 * reader's attention rather than the wire — which is why `"shape"` spends real
 * effort being terse and `"full"` spends none.
 */
export type EncodePolicy = ValuePolicy;

/** Increasing disclosure. The only ordering the clamp below depends on. */
const POLICY_RANK: Record<ValuePolicy, number> = { none: 0, shape: 1, full: 2 };

/**
 * Clamps what the hub asked for to what this app is willing to send.
 *
 * The whole negotiation lives here, in one expression, rather than as a policy
 * check threaded through the encoder: a sender may always answer with less than
 * it was asked for and may never answer with more, and that rule is only
 * trustworthy if there is exactly one place it can be got wrong.
 *
 * Its own module for the same reason. This is the one function in the package
 * whose failure mode is disclosure rather than a bad rendering, and it should be
 * readable — and testable — without the several hundred lines of walking that
 * depend on it.
 */
export function resolvePolicy(requested: ValuePolicy, ceiling: ValuePolicy): EncodePolicy {
  return POLICY_RANK[requested] <= POLICY_RANK[ceiling] ? requested : ceiling;
}
