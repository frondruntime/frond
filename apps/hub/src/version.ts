/**
 * Reported by `--version` and advertised to MCP clients as the server version.
 *
 * Lives here and not in the wire contract: this is the version of the hub
 * binary, and an app that installs the client half has no business seeing it.
 * The number the two sides actually have to agree on is `HUB_PROTOCOL_VERSION`.
 */
export const HUB_VERSION = "0.3.0";
