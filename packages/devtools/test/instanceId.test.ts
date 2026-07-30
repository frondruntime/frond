import { describe, expect, test } from "bun:test";
import { newInstanceId } from "../src/attach.ts";

describe("newInstanceId", () => {
  /**
   * The reason this is not `crypto.randomUUID`, asserted rather than commented,
   * because the obvious "simplification" of this function is to reach for the
   * built-in. React Native has no global `crypto` until a polyfill installs one,
   * and an attach client that needs one crashes the app on the platform least
   * able to explain why.
   *
   * The global is deleted rather than mocked so this also covers the subtler
   * half: a bare `crypto` reference throws a `ReferenceError`, which optional
   * chaining does not catch and `typeof` only suppresses for a bare identifier.
   */
  test("works on a runtime with no crypto global at all", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

    // Deleted, not set to undefined: the two are different runtimes as far as a
    // bare `crypto` reference is concerned, and only this one reproduces RN.
    delete (globalThis as { crypto?: unknown }).crypto;

    try {
      expect(newInstanceId()).toBeTruthy();
    } finally {
      if (original !== undefined) {
        Object.defineProperty(globalThis, "crypto", original);
      }
    }
  });

  /**
   * Unique among the handful of apps on one hub, which is the only uniqueness
   * this id owes anyone. A thousand draws inside the same few milliseconds is
   * far past the real case — two or three apps starting together — so a
   * collision here means the suffix is too short, not that the test got unlucky.
   */
  test("does not collide across a burst far larger than the real case", () => {
    const ids = new Set<string>();

    for (let index = 0; index < 1000; index += 1) {
      ids.add(newInstanceId());
    }

    expect(ids.size).toBe(1000);
  });

  test("is a plain string, safe to use as a key and to read in a dashboard", () => {
    // The suffix quantifier is `*` and not `+` on purpose, and it looks like a
    // slack to tighten. `Math.random().toString(36).slice(2, 10)` is empty for a
    // draw of exactly 0 and short for any draw whose base-36 form is, so `+`
    // would be a test that fails once in a very long while and teaches nothing
    // when it does. The timestamp half is what carries the identity.
    expect(newInstanceId()).toMatch(/^[0-9a-z]+-[0-9a-z]*$/);
  });
});
