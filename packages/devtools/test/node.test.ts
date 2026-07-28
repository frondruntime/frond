import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHubLock } from "../src/node.ts";
import { HUB_DEFAULT_PORT } from "../src/protocol.ts";

const roots: Array<string> = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();

    if (root !== undefined) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "frond-lock-"));

  roots.push(root);

  return root;
}

function writeLock(root: string, port: number, contents: unknown): void {
  mkdirSync(join(root, ".frond"), { recursive: true });
  writeFileSync(join(root, ".frond", `hub-${port}.json`), JSON.stringify(contents));
}

function validLock(port: number): Record<string, unknown> {
  return {
    protocolVersion: 1,
    attachUrl: `ws://127.0.0.1:${port}/attach`,
    host: "127.0.0.1",
    port,
    pid: 4242,
  };
}

describe("readHubLock", () => {
  test("finds a lockfile in the directory it starts from", () => {
    const root = project();

    writeLock(root, HUB_DEFAULT_PORT, validLock(HUB_DEFAULT_PORT));

    expect(readHubLock({ cwd: root })?.port).toBe(HUB_DEFAULT_PORT);
  });

  /**
   * The case the walk exists for. A hub is started from the repository root and
   * the app that wants to attach is usually a package several directories down,
   * running its own dev server.
   */
  test("walks up to find a hub started from the repository root", () => {
    const root = project();
    const nested = join(root, "apps", "web", "src");

    mkdirSync(nested, { recursive: true });
    writeLock(root, HUB_DEFAULT_PORT, validLock(HUB_DEFAULT_PORT));

    expect(readHubLock({ cwd: nested })?.attachUrl).toBe(
      `ws://127.0.0.1:${HUB_DEFAULT_PORT}/attach`
    );
  });

  test("a hub on another port is not this hub", () => {
    const root = project();

    writeLock(root, 19999, validLock(19999));

    expect(readHubLock({ cwd: root })).toBeUndefined();
    expect(readHubLock({ cwd: root, port: 19999 })?.port).toBe(19999);
  });

  test("no hub anywhere up the tree is undefined, not a throw", () => {
    expect(readHubLock({ cwd: project() })).toBeUndefined();
  });

  /**
   * A lockfile outlives the process that wrote it whenever that process died
   * badly, so a half-written or older-format one is the normal bad case rather
   * than the exotic one. Both have to read as "no hub" — an undefined field
   * reaching a caller as a URL is worse than not finding a hub at all.
   */
  test("a malformed lockfile reads as no hub", () => {
    const root = project();

    mkdirSync(join(root, ".frond"), { recursive: true });
    writeFileSync(join(root, ".frond", `hub-${HUB_DEFAULT_PORT}.json`), "{ not json");

    expect(readHubLock({ cwd: root })).toBeUndefined();
  });

  test("a lockfile missing a field reads as no hub", () => {
    const root = project();
    const { attachUrl: _dropped, ...incomplete } = validLock(HUB_DEFAULT_PORT);

    writeLock(root, HUB_DEFAULT_PORT, incomplete);

    expect(readHubLock({ cwd: root })).toBeUndefined();
  });
});
