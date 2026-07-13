import type * as Frond from "@frondruntime/core";
import {
  createFrondTestHarness,
  type FrondTestHarness,
  type FrondTestHarnessOptions,
} from "@frondruntime/core/testing";
import { type ReactNode, useInsertionEffect, useRef } from "react";
import { FrondProvider } from "..";

export interface TestFrondProviderProps {
  readonly runtime?: Frond.Runtime.Runtime | undefined;
  readonly harness?: FrondTestHarness | undefined;
  /**
   * Constructor-time options for the provider-owned harness. Later object
   * identity changes are ignored; key the provider when a new harness is
   * required.
   */
  readonly options?: FrondTestHarnessOptions | undefined;
  readonly children: ReactNode;
}

export function TestFrondProvider({ runtime, harness, options, children }: TestFrondProviderProps) {
  const ownedHarnessRef = useRef<OwnedHarness | undefined>(undefined);

  if (runtime === undefined && harness === undefined && ownedHarnessRef.current === undefined) {
    const ownedHarness = makeOwnedHarness(createFrondTestHarness(options), () => {
      if (ownedHarnessRef.current === ownedHarness) {
        ownedHarnessRef.current = undefined;
      }
    });
    ownedHarnessRef.current = ownedHarness;
  }

  const ownedHarness =
    runtime === undefined && harness === undefined ? ownedHarnessRef.current : undefined;
  const resolvedRuntime = runtime ?? harness?.runtime ?? ownedHarness?.harness.runtime;

  // Insertion effects follow the retained React tree lifetime: unlike passive
  // and layout effects they are not disconnected while Activity is hidden.
  // The generation/ref-count release still tolerates a same-turn revival and
  // makes final teardown independent of wall-clock timers.
  useInsertionEffect(() => ownedHarness?.retain(), [ownedHarness]);

  if (resolvedRuntime === undefined) {
    throw new Error("FrondReactTesting.TestFrondProvider could not resolve a runtime.");
  }

  return <FrondProvider runtime={resolvedRuntime}>{children}</FrondProvider>;
}

interface OwnedHarness {
  readonly harness: FrondTestHarness;
  readonly retain: () => () => void;
}

function makeOwnedHarness(harness: FrondTestHarness, onFinalRelease: () => void): OwnedHarness {
  let generation = 0;
  let retainCount = 0;
  let teardownStarted = false;

  return {
    harness,
    retain: () => {
      generation += 1;
      retainCount += 1;
      let released = false;

      return () => {
        if (released) {
          return;
        }

        released = true;
        retainCount -= 1;
        generation += 1;
        const releaseGeneration = generation;

        queueMicrotask(() => {
          if (teardownStarted || retainCount !== 0 || generation !== releaseGeneration) {
            return;
          }

          teardownStarted = true;
          onFinalRelease();
          harness.teardown().catch((cause: unknown) => {
            console.error("Frond test harness teardown failed.", cause);
          });
        });
      };
    },
  };
}
