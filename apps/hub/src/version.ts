import { HUB_PROTOCOL_VERSION } from "@frondruntime/devtools";

/**
 * What `--version` prints and what the MCP handshake advertises: the protocol
 * generation this build speaks, not the npm version of `@frondruntime/hub`.
 *
 * The npm version answers "which release is this", which nothing on either wire
 * can act on. The protocol version answers "will this talk to my app", which is
 * the only version question a hub is ever asked — by an operator staring at a
 * refused attachment, and by an MCP client deciding what it may call. Reporting
 * the one that cannot be acted on, when the two are free to diverge, is how an
 * operator ends up comparing release numbers that were never the disagreement.
 *
 * The cost, stated plainly because it is real: `--version` no longer identifies
 * a build. Every release for the life of a protocol generation answers the same,
 * so a bug report quoting it says which contract, not which code. `npm ls
 * @frondruntime/hub` is the question that has the other answer.
 *
 * Mechanically this also unbinds the constant from the release tooling. It used
 * to be a literal kept in step with `package.json` by a release-please
 * `extra-files` marker, which silently no-ops if the marker drifts off the
 * version's own line — a hub announcing a version it was not. Derived, there is
 * nothing left to keep in step.
 */
export const HUB_REPORTED_VERSION = String(HUB_PROTOCOL_VERSION);
