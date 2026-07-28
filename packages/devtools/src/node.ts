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
 * Returns `undefined` rather than throwing for every way the file can fail to
 * be a lock: absent, unreadable, or malformed. Not finding a hub is the
 * ordinary state of a machine where nobody started one, and the caller's
 * response to all three is identical anyway.
 *
 * What it does *not* do is decide whether the hub named by a well-formed lock
 * is still there. A hub that died without running its finalizer leaves a file
 * that parses, and this returns it. Liveness is the caller's call and the
 * fields to make it are on the result: `pid` for a signal probe, `port` for a
 * dial, and `protocolVersion` to compare against the one this build speaks. A
 * reader that guessed on the caller's behalf would be guessing wrong for the
 * scripts that only want the address.
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

  // Every field checked rather than cast, because this file outlives the process
  // that wrote it if that process died badly — so what is on disk may have been
  // written by a build that is no longer installed. A shape check is all this
  // does: it says the five fields are there and are the right types, not that
  // the hub behind them is alive or speaks the protocol this build speaks.
  // Those are the caller's to decide, from `pid` and `protocolVersion`.
  return typeof lock.attachUrl === "string" &&
    typeof lock.host === "string" &&
    typeof lock.port === "number" &&
    typeof lock.pid === "number" &&
    typeof lock.protocolVersion === "number"
    ? (lock as HubLock)
    : undefined;
}
