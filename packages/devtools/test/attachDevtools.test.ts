import { describe, expect, test } from "bun:test";
import { createRuntime } from "@frondruntime/core";
import { attachDevtools } from "../src/attachDevtools.ts";
import { HUB_DEFAULT_ATTACH_URL } from "../src/protocol.ts";

/**
 * A port nothing is listening on, so every attempt fails at connect.
 *
 * That is the state these tests care about, and it is also the state an app
 * spends most of its life in: a developer who has not started a hub is the
 * common case, not the error case.
 */
const DEAD_URL = "ws://127.0.0.1:1/attach";

async function runtime() {
  const created = createRuntime();

  await created.submit({ _tag: "RuntimeStart" });

  return created;
}

describe("attachDevtools", () => {
  /**
   * The property the whole front door exists for. This sits in an app's entry
   * file behind nothing but a dev check, so a throw here is a devtools client
   * taking down the app it was supposed to be observing.
   */
  test("dialing a hub that is not there neither throws nor rejects", async () => {
    const detach = attachDevtools({ runtime: await runtime(), url: DEAD_URL, name: "app" });

    // Several retry cycles would not fit here; one is enough to prove the
    // failure is caught rather than propagated, and the loop is asserted below.
    await Bun.sleep(150);

    detach();
  });

  test("errors are reported rather than raised, and it keeps trying", async () => {
    const seen: Array<unknown> = [];

    const detach = attachDevtools({
      runtime: await runtime(),
      url: DEAD_URL,
      name: "app",
      onError: (cause) => {
        seen.push(cause);
      },
    });

    // Longer than one retry delay, so a client that gave up after the first
    // failure reports exactly one cause and fails this.
    await Bun.sleep(2500);
    detach();

    expect(seen.length).toBeGreaterThan(1);
  });

  test("detaching twice is not an error", async () => {
    const detach = attachDevtools({ runtime: await runtime(), url: DEAD_URL, name: "app" });

    detach();
    detach();
  });

  /**
   * The zero-config path: an app that passes no URL gets the default port. It
   * is the whole reason dropping the attach token was worth doing, so it is
   * worth an assertion rather than a comment.
   */
  test("the default URL is the hub's default port on loopback", () => {
    expect(HUB_DEFAULT_ATTACH_URL).toBe("ws://127.0.0.1:17391/attach");
  });
});
