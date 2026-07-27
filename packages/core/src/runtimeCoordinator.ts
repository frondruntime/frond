/**
 * Serializes runtime boot and disposal across replacement generations.
 *
 * Intended dev-HMR usage: store the coordinator on `globalThis` under an
 * app-specific key. A new module generation calls `dispose()` on the retained
 * coordinator, then `start()`. The transition chain guarantees the previous
 * lease is fully disposed before a replacement boots, so two graph
 * generations never overlap. The same guarantees make the coordinator valid
 * for test isolation: boot and tear down a runtime per test without leaking
 * the previous generation into the next.
 */

/**
 * A booted runtime generation: the caller-facing `value` plus the disposer
 * that fully tears the generation down.
 */
export type RuntimeLease<TValue> = Readonly<{
  value: TValue;
  dispose(): Promise<void>;
}>;

/**
 * Rejection of a `start()` whose boot was superseded by a newer `start()` or
 * `dispose()` before it completed. The superseded boot disposes its own lease
 * before rejecting, so nothing leaks.
 */
export class FrondRuntimeBootSuperseded extends Error {
  readonly _tag = "FrondRuntimeBootSuperseded";

  constructor() {
    super("Frond runtime boot was superseded by a newer start() or dispose() before it completed.");
    this.name = "FrondRuntimeBootSuperseded";
  }
}

export type RuntimeCoordinator<TValue> = Readonly<{
  start(createLease: () => Promise<RuntimeLease<TValue>>): Promise<TValue>;
  dispose(): Promise<void>;
}>;

/**
 * Creates a coordinator that serializes `start`/`dispose` transitions.
 *
 * Every transition is chained behind the previous one, so overlapping calls
 * never interleave: a replacement boot begins only after the prior disposal
 * has fully settled. Each `start` claims a generation; if a newer `start` or
 * `dispose` claims a later generation while a boot is in flight, the
 * superseded boot disposes its own lease and rejects with
 * `FrondRuntimeBootSuperseded`.
 */
export function createRuntimeCoordinator<TValue>(): RuntimeCoordinator<TValue> {
  let generation = 0;
  let current: RuntimeLease<TValue> | undefined;
  let transition: Promise<void> = Promise.resolve();

  const start = (createLease: () => Promise<RuntimeLease<TValue>>): Promise<TValue> => {
    const bootGeneration = ++generation;
    const boot = transition.then(async () => {
      if (current !== undefined) {
        throw new Error("Frond runtime is already active; dispose() it before replacement.");
      }

      const lease = await createLease();
      if (generation !== bootGeneration) {
        await lease.dispose();
        throw new FrondRuntimeBootSuperseded();
      }
      current = lease;
      return lease.value;
    });
    transition = boot.then(
      () => undefined,
      () => undefined
    );
    return boot;
  };

  const dispose = (): Promise<void> => {
    generation += 1;
    const disposal = transition.then(async () => {
      const lease = current;
      current = undefined;
      await lease?.dispose();
    });
    transition = disposal.catch(() => undefined);
    return disposal;
  };

  return { start, dispose };
}
