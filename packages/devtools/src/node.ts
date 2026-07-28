import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { HUB_DEFAULT_PORT } from "./protocol.ts";

/**
 * Filesystem discovery for hosts that have a filesystem.
 *
 * Deliberately a separate export from the package root. A browser bundle must
 * never have to resolve `node:fs`, and the reliable way to guarantee that is
 * for the module graph a browser reaches to not contain it — not a runtime
 * guard, which bundlers still follow.
 */

/** What a running hub writes to `.frond/hub-<port>.json`. */
export type HubLock = {
  readonly protocolVersion: number;
  readonly attachUrl: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
};

export type ReadHubLockOptions = {
  /** Which hub to look for. Defaults to the default port. */
  readonly port?: number | undefined;
  /** Where to start searching. Defaults to the process's working directory. */
  readonly cwd?: string | undefined;
};

/**
 * Finds the lockfile of a hub running for this project.
 *
 * Walks up from `cwd` rather than looking only in it, because the hub is
 * started from the repository root and the app that wants to attach usually is
 * not — a monorepo package running its own dev server is the normal case, not
 * the exception.
 *
 * Returns `undefined` rather than throwing on every failure mode there is:
 * absent, unreadable, malformed, or a leftover from a hub that is gone. Not
 * finding a hub is the ordinary state of a machine where nobody started one,
 * and the caller's response to all of these is identical anyway.
 */
export function readHubLock(options: ReadHubLockOptions = {}): HubLock | undefined {
  const port = options.port ?? HUB_DEFAULT_PORT;
  const relative = join(".frond", `hub-${port}.json`);

  let directory = options.cwd ?? process.cwd();
  const root = parse(directory).root;

  for (;;) {
    const found = readLock(join(directory, relative));

    if (found !== undefined) {
      return found;
    }

    if (directory === root) {
      return undefined;
    }

    const parent = dirname(directory);

    // `dirname` is a fixed point at the root on every platform, and on some
    // inputs it reaches one that is not `parse().root`. Without this the loop
    // above would spin forever on exactly the paths nobody tests with.
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

function readLock(path: string): HubLock | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const lock = parsed as Partial<HubLock>;

  // Checked rather than trusted because this file outlives the process that
  // wrote it if that process died badly, and a stale one from an older protocol
  // is precisely the case where a confident cast turns into a wrong answer.
  return typeof lock.attachUrl === "string" &&
    typeof lock.host === "string" &&
    typeof lock.port === "number" &&
    typeof lock.pid === "number" &&
    typeof lock.protocolVersion === "number"
    ? (lock as HubLock)
    : undefined;
}
