import type * as Frond from "@frondruntime/core";
import {
  createFrondTestHarness,
  type FrondTestHarness,
  type FrondTestHarnessOptions,
} from "@frondruntime/core/testing";
import { type ReactNode, useEffect, useMemo } from "react";
import { FrondProvider } from "..";

export interface TestFrondProviderProps {
  readonly runtime?: Frond.Runtime.Runtime | undefined;
  readonly harness?: FrondTestHarness | undefined;
  readonly options?: FrondTestHarnessOptions | undefined;
  readonly children: ReactNode;
}

export function TestFrondProvider({ runtime, harness, options, children }: TestFrondProviderProps) {
  const ownedHarness = useMemo(
    () =>
      runtime === undefined && harness === undefined ? createFrondTestHarness(options) : undefined,
    [runtime, harness, options]
  );
  const resolvedRuntime = runtime ?? harness?.runtime ?? ownedHarness?.runtime;
  useEffect(
    () => () => {
      void ownedHarness?.teardown();
    },
    [ownedHarness]
  );

  if (resolvedRuntime === undefined) {
    throw new Error("FrondReactTesting.TestFrondProvider could not resolve a runtime.");
  }

  return <FrondProvider runtime={resolvedRuntime}>{children}</FrondProvider>;
}
