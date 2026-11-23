import { describe, expect, test } from "bun:test";
import { createRuntime } from "@frondruntime/core";
import { getReactArgsFingerprint, validatedNodeIdResolver } from "../src/argsFingerprint";

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

describe("validatedNodeIdResolver", () => {
  test("a runtime from createRuntime exposes its validated resolver", () => {
    expect(
      validatedNodeIdResolver(createRuntime({ development: true, eventBufferSize: 512 }))
    ).toBeFunction();
  });

  test("a Proxy over a runtime falls back to its public resolver", () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });

    expect(validatedNodeIdResolver(new Proxy(runtime, {}))).toBeUndefined();
  });
});
