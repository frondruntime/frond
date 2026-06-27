import type { NodeRequest, SpecOverride } from "../types";
import { SpecOverrideFailed } from "../types";
import { getNodeDescriptor } from "./descriptor";

export function makeSpecOverrideMap(
  overrides: ReadonlyArray<SpecOverride> = []
): ReadonlyMap<unknown, unknown> {
  const seenOriginals = new Set<unknown>();
  const entries: Array<readonly [unknown, unknown]> = [];

  for (const override of overrides) {
    if (seenOriginals.has(override.from)) {
      throw new SpecOverrideFailed({
        reason: "duplicate-original",
        cause: { invariant: "spec overrides must not contain duplicate original specs" },
      });
    }

    const fromDescriptor = getNodeDescriptor(override.from);
    const toDescriptor = getNodeDescriptor(override.to);

    if (fromDescriptor.tag !== toDescriptor.tag) {
      throw new SpecOverrideFailed({
        reason: "tag-mismatch",
        cause: {
          invariant: "spec override replacement tag must match original tag",
          fromTag: fromDescriptor.tag,
          toTag: toDescriptor.tag,
        },
      });
    }

    seenOriginals.add(override.from);
    entries.push([override.from, override.to]);
  }

  const overrideMap = new Map(entries);

  for (const [from] of entries) {
    assertNoSpecOverrideCycle(overrideMap, from);
  }

  return overrideMap;
}

export function applySpecOverride(
  overrides: ReadonlyMap<unknown, unknown>,
  request: NodeRequest
): NodeRequest {
  const spec = resolveSpecOverride(overrides, request.spec);

  return spec === request.spec ? request : { spec, args: request.args };
}

function resolveSpecOverride(overrides: ReadonlyMap<unknown, unknown>, spec: unknown): unknown {
  const visited = new Set<unknown>();
  let current = spec;

  while (true) {
    const next = overrides.get(current);

    if (next === undefined) {
      return current;
    }

    if (visited.has(current)) {
      throw new SpecOverrideFailed({
        reason: "cycle",
        cause: { invariant: "spec overrides must not contain cycles" },
      });
    }

    visited.add(current);
    current = next;
  }
}

function assertNoSpecOverrideCycle(
  overrides: ReadonlyMap<unknown, unknown>,
  original: unknown
): void {
  const visited = new Set<unknown>();
  let current: unknown = original;

  while (overrides.has(current)) {
    if (visited.has(current)) {
      throw new SpecOverrideFailed({
        reason: "cycle",
        cause: { invariant: "spec overrides must not contain cycles" },
      });
    }

    visited.add(current);
    current = overrides.get(current);
  }
}
