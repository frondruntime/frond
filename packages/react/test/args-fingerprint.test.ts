import { describe, expect, test } from "bun:test";
import { getReactArgsFingerprint } from "../src/argsFingerprint";

describe("React args fingerprint", () => {
  test("uses canonical keys and rejects opaque args", () => {
    const first = { page: 1, query: "first" };
    const second = { query: "first", page: 1 };

    expect(getReactArgsFingerprint(first)).toBe(getReactArgsFingerprint(second));
    expect(getReactArgsFingerprint(undefined)).toBe("canonical:v1:undefined");
    expect(() => getReactArgsFingerprint({ onSelect: () => "ready" })).toThrow(
      "Invalid key input at $.onSelect: only JSON-shaped values are supported."
    );
  });

  test("is stable for canonical args larger than the key size cap", () => {
    const first = { payload: "x".repeat(3_000), page: 1 };
    const second = { page: 1, payload: "x".repeat(3_000) };

    expect(getReactArgsFingerprint(first)).toBe(getReactArgsFingerprint(second));
  });
});
