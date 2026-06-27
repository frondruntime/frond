import type {
  AsyncAcquireDriverContext,
  AsyncDisposeContext,
  AsyncDriver,
  AsyncDriverActionMap,
  AsyncDriverContext,
  Driver,
} from "../driver";
import { Action } from "../driver";
import { createAsyncDriver } from "../driver/asyncDefinition";
import { createDeferred, type DeferredTestValue } from "./deferred";

export interface DeferredOperationCall<TContext, TInput = undefined> {
  readonly ctx: TContext;
  readonly input: TInput;
  readonly callIndex: number;
}

export interface DeferredOperationGate<TContext, TValue, TInput = undefined> {
  readonly calls: ReadonlyArray<DeferredOperationCall<TContext, TInput>>;
  readonly waitForCall: (
    callIndex?: number | undefined
  ) => Promise<DeferredOperationCall<TContext, TInput>>;
  readonly resolveNext: (value: TValue) => void;
  readonly rejectNext: (cause: unknown) => void;
}

export interface DeferredDriverActions<TNode extends object, TArgs, TDeps extends object> {
  readonly [name: string]: DeferredOperationGate<
    AsyncDriverContext<TNode, TArgs, TDeps, unknown>,
    unknown,
    unknown
  >;
}

export interface DeferredDriver<TNode extends object, TArgs, TDeps extends object, TResult> {
  readonly driver: Driver<TNode, TArgs, TDeps, TResult, object>;
  readonly acquire: DeferredOperationGate<
    AsyncAcquireDriverContext<TArgs, TDeps, TResult>,
    TResult
  >;
  readonly refresh: DeferredOperationGate<
    AsyncDriverContext<TNode, TArgs, TDeps, TResult>,
    TResult | undefined
  >;
  readonly release: DeferredOperationGate<AsyncDisposeContext<TNode>, void>;
  readonly actions: DeferredDriverActions<TNode, TArgs, TDeps>;
  readonly acquireCount: number;
  readonly refreshCount: number;
  readonly releaseCount: number;
  readonly actionCount: number;
}

export interface DeferredDriverOptions {
  readonly refresh?: boolean | undefined;
  readonly release?: boolean | undefined;
  readonly actions?: ReadonlyArray<string> | undefined;
}

type InternalDeferredOperationCall<TContext, TValue, TInput> = DeferredOperationCall<
  TContext,
  TInput
> & {
  readonly deferred: DeferredTestValue<TValue>;
};

type CallWaiter<TContext, TInput> = {
  readonly callIndex: number | undefined;
  readonly resolve: (call: DeferredOperationCall<TContext, TInput>) => void;
};

type InternalDeferredOperationGate<TContext, TValue, TInput = undefined> = DeferredOperationGate<
  TContext,
  TValue,
  TInput
> & {
  readonly run: (ctx: TContext, input?: TInput | undefined) => Promise<TValue>;
};

type DeferredDriverSpec<
  TNode extends object,
  TArgs,
  TDeps extends object,
  TResult,
  TActions extends AsyncDriverActionMap<TNode, TArgs, TDeps, TResult>,
> = {
  acquire: AsyncDriver<TNode, TArgs, TDeps, TResult>["acquire"];
  refresh?: NonNullable<AsyncDriver<TNode, TArgs, TDeps, TResult>["refresh"]>;
  release?: NonNullable<AsyncDriver<TNode, TArgs, TDeps, TResult>["release"]>;
  actions?: NonNullable<AsyncDriver<TNode, TArgs, TDeps, TResult, TActions>["actions"]>;
};

export function createDeferredDriver<
  TResult = string,
  TNode extends object = object,
  TArgs = unknown,
  TDeps extends object = object,
>(options: DeferredDriverOptions = {}): DeferredDriver<TNode, TArgs, TDeps, TResult> {
  const acquire = createDeferredOperationGate<
    AsyncAcquireDriverContext<TArgs, TDeps, TResult>,
    TResult
  >();
  const refresh = createDeferredOperationGate<
    AsyncDriverContext<TNode, TArgs, TDeps, TResult>,
    TResult | undefined
  >();
  const release = createDeferredOperationGate<AsyncDisposeContext<TNode>, void>();
  const actionNames = options.actions ?? [];
  assertUniqueActionNames(actionNames);
  const actions = Object.fromEntries(
    actionNames.map((name) => [
      name,
      createDeferredOperationGate<
        AsyncDriverContext<TNode, TArgs, TDeps, unknown>,
        unknown,
        unknown
      >(),
    ])
  ) as Record<
    string,
    InternalDeferredOperationGate<
      AsyncDriverContext<TNode, TArgs, TDeps, unknown>,
      unknown,
      unknown
    >
  >;
  const driverActions = Object.fromEntries(
    Object.entries(actions).map(([name, gate]) => [
      name,
      Action((ctx: AsyncDriverContext<TNode, TArgs, TDeps, TResult>, input: unknown) =>
        gate.run(ctx as AsyncDriverContext<TNode, TArgs, TDeps, unknown>, input)
      ),
    ])
  );

  const driverSpec: DeferredDriverSpec<TNode, TArgs, TDeps, TResult, typeof driverActions> = {
    acquire: (ctx) => acquire.run(ctx),
  };

  if (options.refresh === true) {
    driverSpec.refresh = (ctx: AsyncDriverContext<TNode, TArgs, TDeps, TResult>) =>
      refresh.run(ctx).then(() => undefined);
  }

  if (options.release === true) {
    driverSpec.release = (ctx: AsyncDisposeContext<TNode>) => release.run(ctx);
  }

  if (actionNames.length > 0) {
    driverSpec.actions = driverActions;
  }

  const driver = createAsyncDriver<TNode, TDeps, TResult, TArgs, typeof driverActions>(driverSpec);

  return {
    driver,
    acquire,
    refresh,
    release,
    actions,
    get acquireCount() {
      return acquire.calls.length;
    },
    get refreshCount() {
      return refresh.calls.length;
    },
    get releaseCount() {
      return release.calls.length;
    },
    get actionCount() {
      return Object.values(actions).reduce((count, gate) => count + gate.calls.length, 0);
    },
  };
}

function assertUniqueActionNames(actionNames: ReadonlyArray<string>): void {
  const seen = new Set<string>();

  for (const name of actionNames) {
    if (name.length === 0) {
      throw new Error("Deferred driver action gate name must not be empty.");
    }

    if (seen.has(name)) {
      throw new Error(`Deferred driver action gate "${name}" is duplicated.`);
    }

    seen.add(name);
  }
}

function createDeferredOperationGate<TContext, TValue, TInput = undefined>() {
  const calls: Array<InternalDeferredOperationCall<TContext, TValue, TInput>> = [];
  const waiters: Array<CallWaiter<TContext, TInput>> = [];
  const settledCallIndexes = new Set<number>();
  let callIndex = 0;

  const publicGate = {
    get calls(): ReadonlyArray<DeferredOperationCall<TContext, TInput>> {
      return calls.map(({ ctx, input, callIndex: index }) => ({
        ctx,
        input,
        callIndex: index,
      }));
    },
    waitForCall: (index?: number | undefined) => {
      const existing = calls.find((call) => index === undefined || call.callIndex === index);

      if (existing !== undefined) {
        return Promise.resolve(toPublicCall(existing));
      }

      return new Promise<DeferredOperationCall<TContext, TInput>>((resolve) => {
        waiters.push({ callIndex: index, resolve });
      });
    },
    resolveNext: (value: TValue) => {
      const call = nextUnresolvedCall(calls, settledCallIndexes);
      settledCallIndexes.add(call.callIndex);
      call.deferred.resolve(value);
    },
    rejectNext: (cause: unknown) => {
      const call = nextUnresolvedCall(calls, settledCallIndexes);
      settledCallIndexes.add(call.callIndex);
      call.deferred.reject(cause);
    },
    run: (ctx: TContext, input: TInput = undefined as TInput): Promise<TValue> => {
      const deferred = createDeferred<TValue>();
      const call = {
        ctx,
        input,
        callIndex,
        deferred,
      } satisfies InternalDeferredOperationCall<TContext, TValue, TInput>;
      callIndex += 1;
      calls.push(call);
      notifyWaiters(waiters, call);
      return deferred.promise;
    },
  };

  return publicGate satisfies DeferredOperationGate<TContext, TValue, TInput> & {
    readonly run: (ctx: TContext, input?: TInput | undefined) => Promise<TValue>;
  };
}

function notifyWaiters<TContext, TValue, TInput>(
  waiters: Array<CallWaiter<TContext, TInput>>,
  call: InternalDeferredOperationCall<TContext, TValue, TInput>
): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];

    if (waiter === undefined) {
      continue;
    }

    if (waiter.callIndex !== undefined && waiter.callIndex !== call.callIndex) {
      continue;
    }

    waiters.splice(index, 1);
    waiter.resolve(toPublicCall(call));
  }
}

function nextUnresolvedCall<TContext, TValue, TInput>(
  calls: ReadonlyArray<InternalDeferredOperationCall<TContext, TValue, TInput>>,
  settledCallIndexes: ReadonlySet<number>
): InternalDeferredOperationCall<TContext, TValue, TInput> {
  const call = calls.find((entry) => !settledCallIndexes.has(entry.callIndex));

  if (call === undefined) {
    throw new Error("Deferred operation gate has no pending call to resolve.");
  }

  return call;
}

function toPublicCall<TContext, TValue, TInput>(
  call: InternalDeferredOperationCall<TContext, TValue, TInput>
): DeferredOperationCall<TContext, TInput> {
  return {
    ctx: call.ctx,
    input: call.input,
    callIndex: call.callIndex,
  };
}
