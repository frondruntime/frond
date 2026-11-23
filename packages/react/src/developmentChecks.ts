import { _getGlobalState } from "mobx";
import { isUsingStaticRendering } from "mobx-react-lite";
import { FrondReactUsageError } from "./errors";

/**
 * Throws in development when a result hook renders outside a MobX observer,
 * on every call, so the mistake fails the render that makes it. Static
 * rendering (server rendering through `enableStaticRendering`) tracks
 * nothing and is exempt.
 */
export function assertInsideObserver(hook: string, specs: ReadonlyArray<unknown>): void {
  if (_getGlobalState().trackingDerivation !== null) return;
  if (isUsingStaticRendering()) return;
  const names = specs.map(specName).join(", ");
  throw new FrondReactUsageError({
    hook,
    message: `${hook}(${names}) rendered outside a MobX observer. A result write rerenders only observer components; wrap this component in observer() from mobx-react-lite.`,
  });
}

function specName(spec: unknown): string {
  if (typeof spec !== "function" && (typeof spec !== "object" || spec === null)) {
    return "anonymous node";
  }
  const name = (spec as { readonly name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : "anonymous node";
}
