import { describe, expect, test } from "bun:test";
import { mobxRuntimeMetadata } from "../src/mobx/metadata";

describe("mobx runtime metadata", () => {
  test("each accessor carries the mobx source and the expected reason/priority", () => {
    expect(mobxRuntimeMetadata.readiness()).toEqual({
      source: "mobx",
      reason: "readiness",
      priority: "visible",
    });
    expect(mobxRuntimeMetadata.action()).toEqual({
      source: "mobx",
      reason: "action",
      priority: "visible",
    });
    expect(mobxRuntimeMetadata.refresh()).toEqual({
      source: "mobx",
      reason: "refresh",
      priority: "background",
    });
    expect(mobxRuntimeMetadata.release()).toEqual({
      source: "mobx",
      reason: "release",
      priority: "background",
    });
    expect(mobxRuntimeMetadata.eviction()).toEqual({
      source: "mobx",
      reason: "eviction",
      priority: "blocking",
    });
  });

  test("repeated accessor calls return a shared frozen instance", () => {
    expect(mobxRuntimeMetadata.readiness()).toBe(mobxRuntimeMetadata.readiness());
    expect(mobxRuntimeMetadata.action()).toBe(mobxRuntimeMetadata.action());
    expect(mobxRuntimeMetadata.refresh()).toBe(mobxRuntimeMetadata.refresh());
    expect(mobxRuntimeMetadata.release()).toBe(mobxRuntimeMetadata.release());
    expect(mobxRuntimeMetadata.eviction()).toBe(mobxRuntimeMetadata.eviction());
    expect(Object.isFrozen(mobxRuntimeMetadata.readiness())).toBe(true);
  });
});
