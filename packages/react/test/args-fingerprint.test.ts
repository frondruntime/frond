import { describe, expect, test } from "bun:test";
import { getReactArgsFingerprint } from "../src/argsFingerprint";

describe("React args fingerprint", () => {
  test("uses canonical keys first and reference identity for opaque args", () => {
    const first = { page: 1, query: "first" };
    const second = { query: "first", page: 1 };
    const callback = () => "ready";

    expect(getReactArgsFingerprint(first)).toBe(getReactArgsFingerprint(second));
    expect(getReactArgsFingerprint(callback)).toBe(getReactArgsFingerprint(callback));
    expect(getReactArgsFingerprint(() => "ready")).not.toBe(getReactArgsFingerprint(() => "ready"));
    expect(getReactArgsFingerprint(undefined)).toBe("canonical:v1:undefined");
  });
});
