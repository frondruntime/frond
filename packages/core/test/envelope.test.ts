import { describe, expect, test } from "bun:test";
import { observable } from "mobx";
import { carryInternal, internalOf, type WithInternal, withInternal } from "../src";

type PublicResult = { readonly userId: string };
type Internal = { readonly socket: { readonly id: string } };

function makeEnveloped(): {
  enveloped: WithInternal<PublicResult, Internal>;
  internal: Internal;
} {
  const internal: Internal = { socket: { id: "socket-1" } };
  return { enveloped: withInternal<PublicResult, Internal>({ userId: "u1" }, internal), internal };
}

describe("envelope", () => {
  test("withInternal/internalOf round-trip is typed and returns the same object", () => {
    const publicResult: PublicResult = { userId: "u1" };
    const internal: Internal = { socket: { id: "socket-1" } };

    const enveloped = withInternal(publicResult, internal);

    // Same object reference: envelope attaches in place, it does not copy.
    expect(enveloped).toBe(publicResult as WithInternal<PublicResult, Internal>);
    expect(enveloped.userId).toBe("u1");

    // Fully typed read: no cast needed to get Internal back.
    const roundTripped: Internal = internalOf(enveloped);
    expect(roundTripped).toBe(internal);
  });

  test("JSON.stringify and enumeration exclude the envelope slot", () => {
    const { enveloped } = makeEnveloped();

    expect(JSON.stringify(enveloped)).toBe('{"userId":"u1"}');
    expect(Object.keys(enveloped)).toEqual(["userId"]);
    expect(Object.entries(enveloped)).toEqual([["userId", "u1"]]);
  });

  test("object spread drops the slot and carryInternal restores it", () => {
    const { enveloped, internal } = makeEnveloped();

    // Document the footgun: `setResult(cur => ({ ...cur }))` produces exactly
    // this replacement object, and the non-enumerable slot does not survive.
    const replacement = { ...enveloped };
    expect(() => internalOf(replacement)).toThrow(TypeError);

    const restored = carryInternal(enveloped, replacement);
    expect(restored).toBe(replacement as WithInternal<PublicResult, Internal>);
    expect(internalOf(restored)).toBe(internal);
    expect(restored.userId).toBe("u1");
  });

  test("internalOf without a slot throws a TypeError naming the helpers", () => {
    const bare = { userId: "u1" } as WithInternal<PublicResult, Internal>;

    expect(() => internalOf(bare)).toThrow(TypeError);
    expect(() => internalOf(bare)).toThrow(/internalOf/);
    expect(() => internalOf(bare)).toThrow(/withInternal/);
    expect(() => internalOf(bare)).toThrow(/carryInternal/);
  });

  test("MobX observable.ref result keeps the slot readable without leaking it to enumeration", () => {
    const { enveloped, internal } = makeEnveloped();

    const store = observable({ result: enveloped }, { result: observable.ref }, { deep: false });

    // observable.ref keeps the reference, so the envelope stays readable.
    expect(store.result).toBe(enveloped);
    expect(internalOf(store.result)).toBe(internal);

    // The slot never leaks into enumeration or serialization of the result.
    expect(Object.keys(store.result)).toEqual(["userId"]);
    expect(JSON.stringify(store.result)).toBe('{"userId":"u1"}');
    expect(JSON.stringify(store)).toBe('{"result":{"userId":"u1"}}');
  });
});
