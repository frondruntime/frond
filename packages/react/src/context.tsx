import type * as Frond from "@frondruntime/core";
import { createContext, type ReactNode, useContext } from "react";
import { FrondReactUsageError } from "./errors";

const FrondRuntimeContext = createContext<Frond.Runtime.Runtime | undefined>(undefined);

export interface FrondProviderProps {
  readonly runtime: Frond.Runtime.Runtime;
  readonly children: ReactNode;
}

/**
 * Provides one Frond runtime to React hooks.
 *
 * Create the runtime outside render churn and pass the same instance for the app
 * lifetime unless intentionally resetting the graph.
 */
export function FrondProvider({ runtime, children }: FrondProviderProps): ReactNode {
  return <FrondRuntimeContext.Provider value={runtime}>{children}</FrondRuntimeContext.Provider>;
}

/**
 * Reads the current Frond runtime from React context.
 *
 * This is an adapter boundary. Components receive the Promise/sync facade, not
 * the Effect-native runtime host.
 */
export function useRuntime(): Frond.Runtime.Runtime {
  const runtime = useContext(FrondRuntimeContext);

  if (runtime === undefined) {
    throw new FrondReactUsageError({
      hook: "useRuntime",
      message: "FrondReact.useRuntime must be used inside FrondReact.FrondProvider.",
    });
  }

  return runtime;
}

/**
 * Reads the runtime node client from React context.
 */
export function useRuntimeClient(): Frond.Runtime.RuntimeClient {
  return useRuntime().client;
}
