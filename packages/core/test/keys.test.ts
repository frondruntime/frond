import { describe, expect, test } from "bun:test";
import { Key } from "../src";

describe("keys", () => {
  test("Key exposes singleton and structured key helpers", () => {
    const structured = Key.structure({ outer: { b: 1, a: 2 } });

    expect(Key.singleton()).toBe("singleton");
    expect(structured).toEqual({ outer: { b: 1, a: 2 } });
  });

  test("canonicalKey is deterministic for nested object order", () => {
    const first = Key.canonicalKey({ outer: { b: 1, a: 2 } });
    const second = Key.canonicalKey({ outer: { a: 2, b: 1 } });

    expect(first).toBe(second);
    expect(first).toBe('v1:{"outer":{"a":2,"b":1}}');
  });

  test("canonicalKey treats undefined fields distinctly from missing fields", () => {
    expect(Key.canonicalKey({ a: undefined })).not.toBe(Key.canonicalKey({}));
    expect(Key.canonicalKey({ a: undefined })).toBe('v1:{"a":undefined}');
  });

  test("canonicalKey rejects unsupported key values with typed errors", () => {
    expect(() => Key.canonicalKey(Number.NaN)).toThrow(Key.KeyNonFiniteNumberError);
    expect(() => Key.canonicalKey(Number.POSITIVE_INFINITY)).toThrow(Key.KeyNonFiniteNumberError);
    expect(() => Key.canonicalKey(new Date("2026-01-01T00:00:00.000Z"))).toThrow(
      Key.KeyUnsupportedJsonValueError
    );
    expect(() => Key.canonicalKey(() => "x")).toThrow(Key.KeyUnsupportedJsonValueError);
  });

  test("canonicalKey encodes primitives, null, booleans, and nested arrays", () => {
    expect(Key.canonicalKey("hello")).toBe('v1:"hello"');
    expect(Key.canonicalKey(42)).toBe("v1:42");
    expect(Key.canonicalKey(true)).toBe("v1:true");
    expect(Key.canonicalKey(null)).toBe("v1:null");
    expect(Key.canonicalKey(undefined)).toBe("v1:undefined");
    expect(Key.canonicalKey({ flag: true, items: [1, null, "x"], missing: null })).toBe(
      'v1:{"flag":true,"items":[1,null,"x"],"missing":null}'
    );
  });

  test("canonicalKey encodes sparse array holes as undefined", () => {
    // Build a genuine hole at index 1 without a sparse-array literal.
    const sparse = Array<number>(3);
    sparse[0] = 1;
    sparse[2] = 3;

    expect(1 in sparse).toBe(false);
    expect(Key.canonicalKey(sparse)).toBe("v1:[1,undefined,3]");
  });

  test("canonicalKey reports the path of a nested non-finite number", () => {
    // Validation walks object keys in sorted order, so "a" (NaN) is reported
    // before "b" even though it is declared second.
    try {
      Key.canonicalKey({ b: 1, a: Number.NaN });
      throw new Error("expected canonicalKey to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Key.KeyNonFiniteNumberError);
      expect((error as { path: string }).path).toBe("$.a");
    }
  });

  test("canonicalKey reports the path of a nested unsupported value", () => {
    try {
      Key.canonicalKey({ items: [1, new Date("2026-01-01T00:00:00.000Z")] });
      throw new Error("expected canonicalKey to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Key.KeyUnsupportedJsonValueError);
      expect((error as { path: string }).path).toBe("$.items[1]");
    }
  });

  test("canonicalKey enforces the maximum key length", () => {
    const overhead = Key.canonicalKey({ a: "" }).length;
    const exactPayloadLength = Key.MAX_CANONICAL_KEY_LENGTH - overhead;

    expect(Key.canonicalKey({ a: "x".repeat(exactPayloadLength) })).toHaveLength(
      Key.MAX_CANONICAL_KEY_LENGTH
    );
    expect(() => Key.canonicalKey({ a: "x".repeat(exactPayloadLength + 1) })).toThrow(
      Key.KeyTooLongError
    );
  });
});
