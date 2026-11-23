/** A never-rejecting readiness promise with React's synchronous read metadata. */
export type SuspendPromise = Promise<void> & {
  status: "pending" | "fulfilled";
  value: undefined;
};

export type SuspenseRead<T> =
  | { readonly _tag: "Ready"; readonly value: T }
  | { readonly _tag: "Pending"; readonly promise: SuspendPromise };

// Component-local stores disappear when an initial render suspends. Core
// attempts outlive those stores, so every reader of an attempt shares a wrapper.
const wrappers = new WeakMap<Promise<unknown>, SuspendPromise>();
// A composite wakes early when one child fails, so a failure is not held back
// by pending siblings. Each settles only when its attempt fails: it rejects or
// resolves with an Error read.
const failures = new WeakMap<SuspendPromise, Promise<void>>();
const failed = new WeakSet<SuspendPromise>();

export function suspendPromise(attempt: Promise<unknown>): SuspendPromise {
  const cached = wrappers.get(attempt);
  if (cached !== undefined) return cached;

  const settle = (): void => {
    promise.status = "fulfilled";
    promise.value = undefined;
  };
  const failure = Promise.withResolvers<void>();
  const fail = (): void => {
    failed.add(promise);
    settle();
    failure.resolve();
  };
  const promise: SuspendPromise = Object.assign(
    attempt.then((value) => (isErrorRead(value) ? fail() : settle()), fail),
    {
      status: isSettled(attempt) ? ("fulfilled" as const) : ("pending" as const),
      value: undefined,
    }
  );
  if (isFailed(attempt)) failed.add(promise);
  failures.set(promise, failure.promise);
  wrappers.set(attempt, promise);
  return promise;
}

function isErrorRead(value: unknown): boolean {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === "Error";
}

function isSettled(attempt: Promise<unknown>): boolean {
  return "status" in attempt && (attempt.status === "fulfilled" || attempt.status === "rejected");
}

function isFailed(attempt: Promise<unknown>): boolean {
  if (!("status" in attempt)) return false;
  if (attempt.status === "rejected") return true;
  return attempt.status === "fulfilled" && "value" in attempt && isErrorRead(attempt.value);
}

interface CompositeCache {
  readonly children: WeakMap<SuspendPromise, CompositeCache>;
  promise?: SuspendPromise;
}

const composites: CompositeCache = { children: new WeakMap() };
const attemptOrder = new WeakMap<SuspendPromise, number>();
let nextOrder = 0;

function order(attempt: SuspendPromise): number {
  let current = attemptOrder.get(attempt);
  if (current === undefined) {
    current = nextOrder;
    nextOrder += 1;
    attemptOrder.set(attempt, current);
  }
  return current;
}

/** The same set of child wrappers shares one composite, across store rebuilds. */
export function compositeSuspendPromise(attempts: ReadonlyArray<SuspendPromise>): SuspendPromise {
  const unique = [...new Set(attempts)];
  for (const attempt of unique) order(attempt);
  unique.sort((left, right) => order(left) - order(right));
  let cache = composites;
  for (const attempt of unique) {
    let child = cache.children.get(attempt);
    if (child === undefined) {
      child = { children: new WeakMap() };
      cache.children.set(attempt, child);
    }
    cache = child;
  }
  if (cache.promise === undefined) {
    const wake = Promise.race([
      Promise.all(unique),
      ...unique.flatMap((child) => failures.get(child) ?? []),
    ]);
    // The race itself settles in a microtask, even for settled inputs.
    // React can consume an already-settled child set synchronously.
    const settled =
      unique.every((child) => child.status === "fulfilled") ||
      unique.some((child) => failed.has(child));
    const attempt = Object.assign(wake, { status: settled ? "fulfilled" : "pending" });
    cache.promise = suspendPromise(attempt);
  }
  return cache.promise;
}
