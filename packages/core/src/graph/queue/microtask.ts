const resolved = Promise.resolve();

const reportUncaught = (cause: unknown): void => {
  queueMicrotask(() => {
    throw cause;
  });
};

/**
 * Runs `callback` in a microtask through a resolved promise. Jest's default
 * fake timers hold `queueMicrotask` callbacks but not promise reactions, so
 * graph work keeps running under them, as it did in 0.5. A throw still reaches
 * the host's uncaught-error report instead of becoming an unhandled rejection.
 */
export function runInMicrotask(callback: () => void): void {
  resolved.then(callback).catch(reportUncaught);
}
