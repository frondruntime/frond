import type { Runtime } from "@frondruntime/core";
import { Cause, Data, Effect, Fiber } from "effect";
import { attachLayer, attachRuntime, newInstanceId } from "./attach.ts";
import { HUB_DEFAULT_ATTACH_URL, HubRejection, type ValuePolicy } from "./protocol.ts";

/**
 * How long to wait before dialing again.
 *
 * Fixed rather than backing off: the hub is a process on the same machine that
 * a developer starts and stops by hand, and an app that had backed off to
 * thirty seconds would spend most of a debugging session not yet reconnected.
 * Two seconds of an idle loopback socket costs nothing worth measuring.
 */
const RETRY_DELAY = "2 seconds";

/**
 * Ends the retry loop.
 *
 * A second error rather than reusing `HubRejection`, because the two travel in
 * opposite directions through the same code: `HubRejection` arrives from the
 * hub into an attempt that swallows everything, and this one has to get back
 * *out* of that swallowing. Keeping them distinct is what lets the loop stop for
 * exactly one thing.
 */
class AttachRefused extends Data.TaggedError("AttachRefused")<{
  readonly reason: string;
}> {}

/**
 * The hub's refusal, picked out of whatever else an attempt failed with.
 *
 * Matched on the error value's own identity, not on message text: a refusal is
 * the one outcome that stops the loop forever, and "the message looked like a
 * rejection" is not a property worth betting that on.
 *
 * The refusal is a typed failure here rather than a defect or a closed stream
 * because the RPC roles are inverted from who dials — the app is the *client*,
 * so the hub's `Attach` error channel is this side's error channel, and the
 * decoded `HubRejection` lands as an ordinary `Fail` on the cause.
 */
function refusal(cause: Cause.Cause<unknown>): HubRejection | undefined {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof HubRejection) {
      return reason.error;
    }
  }

  return undefined;
}

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
  /**
   * Stable identity for this app across reconnects. A fresh UUID by default.
   *
   * Also the escape hatch for a runtime without `crypto.randomUUID` — React
   * Native, until a polyfill installs one. Any string does, so long as it is
   * stable for the life of the process and distinct per running app.
   */
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
   *
   * The one exception is a hub that *refuses* the attachment, which is terminal
   * rather than normal. Supplying this takes ownership of reporting it: the
   * console fallback below fires only when this is absent.
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
 * "Forever" has one deliberate exception. A hub that *refuses* the attachment —
 * today, only a protocol version mismatch — is answering a question about this
 * build, and every retry would ask it again and get the same answer. So a
 * refusal stops the loop and says so out loud, because the alternative is what
 * this used to do: reconnect every two seconds, silently, for the whole life of
 * a process that was never going to attach.
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
  const instanceId = options.instanceId ?? newInstanceId();

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
    Effect.catchCause((cause) => {
      options.onError?.(cause);

      const refused = refusal(cause);

      // Every other ending is worth another attempt — a hub not started yet, a
      // socket dropped, a port moved — and retrying them is the behavior this
      // whole loop exists for. A refusal is not one of those: the next attempt
      // sends the same version and earns the same answer, so it leaves as a
      // failure, which is the one thing `forever` below does not swallow.
      return refused === undefined ? Effect.void : new AttachRefused({ reason: refused.reason });
    })
  );

  // `forever` over a *caught* attempt rather than `retry` over a failing one,
  // so the loop is reached by both outcomes. A hub that closes the stream
  // cleanly on shutdown is a success, and a success that stopped reconnecting
  // would leave the app permanently detached from the next hub.
  const fiber = Effect.runFork(
    Effect.forever(Effect.andThen(session, Effect.sleep(RETRY_DELAY))).pipe(
      Effect.catchTag("AttachRefused", (refused) =>
        Effect.sync(() => {
          // Reached at most once per call, and that is structural rather than
          // guarded by a flag: getting here at all means the loop has stopped.
          //
          // Written to the console only when nobody asked for the causes. An
          // app that passed `onError` has already been told, in the handler it
          // supplied, and owns what it does with it; an app that did not would
          // otherwise be left with devtools that will never connect and nothing
          // anywhere saying so — which is the exact failure this whole change
          // is about, and a silent default would only move it one layer down.
          if (options.onError === undefined) {
            console.error(`[frond] devtools attach refused: ${refused.reason}`);
          }
        })
      )
    )
  );

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
