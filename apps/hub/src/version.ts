import { HUB_PROTOCOL_VERSION } from "@frondruntime/devtools";
import packageJson from "../package.json" with { type: "json" };

/**
 * What `--version` prints: the release and the wire contract, in that order.
 *
 * Both, because they answer different questions and an integrator hit exactly
 * the confusion that reporting only one causes. The package version says which
 * build is installed, which is what a bug report needs. The protocol version
 * says what this build will talk to, which is the only number an attaching app
 * compares — and the only one that explains a refused attachment.
 *
 * The release half is read from `package.json` rather than copied into a
 * constant here. An earlier version of this file kept a literal in step through
 * a release-please `extra-files` marker, which silently no-ops when the marker
 * drifts off the version's own line — the failure that made `--version` a
 * problem in the first place. Reading the file that release-please already owns
 * leaves nothing to keep in step.
 */
export const HUB_REPORTED_VERSION = `${packageJson.version} (protocol ${HUB_PROTOCOL_VERSION})`;

/**
 * Advertised to MCP clients as the server version.
 *
 * The bare package version, because MCP's `serverInfo.version` is specified as
 * the version of the server implementation and clients display it as such.
 * Protocol and the rest of the version surface belong in tool output, where a
 * caller can read them as data instead of parsing them out of a label.
 */
export const HUB_MCP_VERSION = packageJson.version;
