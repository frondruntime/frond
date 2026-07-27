import { FROND_NODE_SPEC_BRAND } from "./types";

type AbstractConstructor = abstract new (...args: ReadonlyArray<never>) => object;

/**
 * Shared override-class mechanic for spec overrides.
 *
 * Brands the (already assembled) override descriptor and extends the original
 * class so instances remain `instanceof` the original while the static `spec`
 * carries the override descriptor. Policy — which descriptor members are
 * replaced (driver only vs severed dependencies) and how the returned class is
 * typed — stays with the callers (`specWithDriver`, the testing overrides).
 */
export function makeSpecOverrideClass(
  original: unknown,
  overrideDescriptor: object
): AbstractConstructor & { readonly spec: object } {
  Object.defineProperty(overrideDescriptor, FROND_NODE_SPEC_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  abstract class SpecOverride extends (original as AbstractConstructor) {
    static readonly spec = overrideDescriptor;
  }

  return SpecOverride;
}
