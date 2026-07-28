import { describe, expect, test } from "bun:test";
import { resolvePolicy } from "../src/encode.ts";
import type { ValuePolicy } from "../src/protocol.ts";

const POLICIES: ReadonlyArray<ValuePolicy> = ["none", "shape", "full"];

describe("value policy negotiation", () => {
  test("the hub's request wins when it asks for less than the ceiling", () => {
    expect(resolvePolicy("shape", "full")).toBe("shape");
    expect(resolvePolicy("none", "shape")).toBe("none");
  });

  test("the ceiling wins when the hub asks for more", () => {
    expect(resolvePolicy("full", "shape")).toBe("shape");
    expect(resolvePolicy("shape", "none")).toBe("none");
  });

  test("an equal request and ceiling resolve to themselves", () => {
    for (const policy of POLICIES) {
      expect(resolvePolicy(policy, policy)).toBe(policy);
    }
  });

  /**
   * The rule this whole function exists for, asserted over the entire domain
   * rather than at the two boundaries: a sender may answer with less than it
   * was asked for and may never answer with more. Nine cases is cheap, and the
   * failure it guards against — a clamp that inverts — reads as correct in
   * every individual example.
   */
  test("the result never exceeds either the request or the ceiling", () => {
    const rank = { none: 0, shape: 1, full: 2 } as const;

    for (const requested of POLICIES) {
      for (const ceiling of POLICIES) {
        const resolved = resolvePolicy(requested, ceiling);

        expect(rank[resolved]).toBeLessThanOrEqual(rank[requested]);
        expect(rank[resolved]).toBeLessThanOrEqual(rank[ceiling]);
      }
    }
  });
});
