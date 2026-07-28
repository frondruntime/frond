/**
 * Reported by `--version` and advertised to MCP clients as the server version.
 *
 * Lives here and not in the wire contract: this is the version of the hub
 * binary, and an app that installs the client half has no business seeing it.
 * The number the two sides actually have to agree on is `HUB_PROTOCOL_VERSION`.
 */
// The marker has to sit on the same line as the version. release-please's
// generic updater matches the line and then rewrites a semver *on that line* —
// on its own line it matches, finds no version to replace, and silently leaves
// this constant behind while package.json moves on.
export const HUB_VERSION = "0.2.0"; // x-release-please-version
