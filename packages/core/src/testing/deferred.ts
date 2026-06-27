export interface DeferredTestValue<TValue> {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue | PromiseLike<TValue>) => void;
  readonly reject: (cause: unknown) => void;
}

export function createDeferred<TValue>(): DeferredTestValue<TValue> {
  let resolve!: DeferredTestValue<TValue>["resolve"];
  let reject!: DeferredTestValue<TValue>["reject"];
  const promise = new Promise<TValue>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
