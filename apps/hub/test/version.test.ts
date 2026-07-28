import { describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import { HUB_VERSION } from "../src/version.ts";

/**
 * The hub carries its version twice: in `package.json`, which the registry and
 * release-please own, and in `version.ts`, which `--version` and the MCP server
 * handshake read. release-please keeps the second in step through an
 * `extra-files` entry driven by an `x-release-please-version` marker.
 *
 * That marker is easy to get wrong in a way nothing else notices. The updater
 * matches the line the marker is on and rewrites a semver *on that line*, so a
 * marker parked on its own line above the constant matches, finds nothing to
 * replace, and leaves the constant at the old version — no error, no warning.
 * The hub then ships announcing a version it is not.
 *
 * This runs in CI on the release PR, which is the moment the two can first
 * disagree, and fails it there rather than after publish.
 */
describe("hub version", () => {
  test("matches the version in package.json", () => {
    expect(HUB_VERSION).toBe(packageJson.version);
  });
});
