import { use, useEffect, useMemo } from "react";
import { FrondReactAdapterInvariant } from "./errors";
import type { SuspendPromise, SuspenseRead } from "./suspendPromise";

/** Preserve settled use() slots until commit across suspended replays. */
export function useReadyRead<T>(read: () => SuspenseRead<T>): T {
  const reader = useMemo(() => ({ read, attempts: new Set<SuspendPromise>() }), [read]);
  const { attempts } = reader;
  useEffect(() => {
    attempts.clear();
  });

  // Replay fulfilled use() slots so React can mount later hooks. Consume pending
  // attempts through the current read so they cannot hide an already Ready node.
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled") use(attempt);
  }

  let current = reader.read();
  while (current._tag === "Pending") {
    const attempt = current.promise;
    if (attempts.has(attempt) && attempt.status === "fulfilled") {
      throw new FrondReactAdapterInvariant({
        hook: "useReadyRead",
        message: "Frond readiness did not advance after its Suspense attempt settled.",
      });
    }
    attempts.add(attempt);
    use(attempt);
    // A fulfilled gate may expose a newer attempt or a readiness error.
    current = reader.read();
  }
  return current.value;
}
