import type { Runtime } from "@frondruntime/core";
import { Effect, Fiber } from "effect";
import { attachLayer, attachRuntime } from "./attach.ts";
import { HUB_DEFAULT_ATTACH_URL, type ValuePolicy } from "./protocol.ts";

/**
 * How long to wait before dialing again.
 *
 * Fixed rather than backing off: the hub is a process on the same machine that
 * a developer starts and stops by hand, and an app that had backed off to
 * thirty seconds would spend most of a debugging session not yet reconnected.
 * Two seconds of an idle loopback socket costs nothing worth measuring.
 */
const RETRY_DELAY = "2 seconds";

export type DevtoolsOptions = {
  readonly runtime: Runtime.Runtime;
  /** Human label for the hub's list, e.g. the host app's package name. */
  readonly name: string;
  /**
   * Where to dial. Defaults to the hub's own default port on loopback.
   *
   * Worth setting for a non-default port, and required for anything that is not
   * on the same host as the hub — a real iOS device or an Android emulator
   * cannot reach `127.0.0.1`, and needs the developer machine's LAN address.
   */
  readonly url?: string | undefined;
  /** Free-form origin hint. Guessed from the environment when omitted. */
  readonly platform?: string | undefined;
  /** See {@link import("./attach.ts").AttachOptions.values}. Defaults to `"shape"`. */
  readonly values?: ValuePolicy | undefined;
  readonly instanceId?: string | undefined;
  /** Return false to leave a record out of the stream entirely. */
  readonly include?: ((record: Runtime.RuntimeEventRecord) => boolean) | undefined;
  /**
   * Called instead of failing, on every attempt that ends badly.
   *
   * Silent by default, and that is the right default: not being able to reach
   * the hub is the *normal* state of an app whose developer has not started one
   * yet, and a devtools client that logged about it once every two seconds
   * would be a worse citizen of the console than one that says nothing.
   */
  readonly onError?: ((cause: unknown) => void) | undefined;
};

/**
 * Streams a runtime's events to a local hub for as long as the app lives.
 *
 * The plain-function front door, as opposed to {@link attachRuntime}: a host
 * app's entry file is not an Effect program, and making one the price of
 * admission would put this behind a rewrite nobody is going to do.
 *
 * Three properties make it safe to leave in an entry file behind nothing but a
 * dev check. It never throws and never rejects, so a devtools client cannot
 * take down the app it is observing. It retries forever, so the hub can be
 * started, stopped and restarted underneath a running app. And it returns
 * before it connects, so it costs the startup path nothing.
 *
 * @example
 * ```ts
 * if (import.meta.env.DEV) {
 *   attachDevtools({ runtime, name: "checkout-web" });
 * }
 * ```
 *
 * @returns A function that detaches. Idempotent, and safe to ignore.
 */
export function attachDevtools(options: DevtoolsOptions): () => void {
  const url = options.url ?? HUB_DEFAULT_ATTACH_URL;

  // Minted here rather than per attempt, so a hub restart underneath a running
  // app brings back the same runtime instead of an apparent stranger. Paired
  // with `generation` below, which is what says how many times that happened.
  const instanceId = options.instanceId ?? crypto.randomUUID();

  let generation = 0;

  // Deferred so each attempt reads the counter as it stands, and bumped only
  // when the hub accepted — a hub that is simply not running yet must not
  // inflate this every two seconds.
  const session = Effect.suspend(() =>
    attachRuntime({
      runtime: options.runtime,
      attachUrl: url,
      name: options.name,
      platform: options.platform ?? detectPlatform(),
      instanceId,
      generation,
      onAttached: () => {
        generation += 1;
      },
      ...(options.values === undefined ? {} : { values: options.values }),
      ...(options.include === undefined ? {} : { include: options.include }),
    })
  ).pipe(
    Effect.scoped,
    Effect.provide(attachLayer(url)),
    // `catchCause`, not `catch`: a defect in the transport is exactly as much
    // the host app's problem as a failure is, which is to say none.
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        options.onError?.(cause);
      })
    )
  );

  // `forever` over a *caught* attempt rather than `retry` over a failing one,
  // so the loop is reached by both outcomes. A hub that closes the stream
  // cleanly on shutdown is a success, and a success that stopped reconnecting
  // would leave the app permanently detached from the next hub.
  const fiber = Effect.runFork(Effect.forever(Effect.andThen(session, Effect.sleep(RETRY_DELAY))));

  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}

/** What `detectPlatform` reads. Everything on it is assumed absent. */
type PlatformGlobals = {
  readonly document?: unknown;
  readonly navigator?: { readonly product?: string };
  readonly process?: { readonly versions?: { readonly bun?: string } };
};

/**
 * A best-effort origin hint for the hub's list.
 *
 * Read off `globalThis` rather than referenced directly, for two reasons: a
 * bare `process` in a browser is a ReferenceError rather than `undefined`, and
 * naming it directly would drag `@types/node` into an entry point whose whole
 * claim is that it does not depend on Node.
 */
function detectPlatform(): string {
  const globals = globalThis as PlatformGlobals;

  if (globals.document !== undefined) {
    return "web";
  }

  if (globals.navigator?.product === "ReactNative") {
    return "react-native";
  }

  if (globals.process !== undefined) {
    return globals.process.versions?.bun === undefined ? "node" : "bun";
  }

  return "unknown";
}
