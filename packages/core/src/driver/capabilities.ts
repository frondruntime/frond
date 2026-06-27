import type { ActionAdmission, DriverActionRegistry, DriverActionRun, DriverHook } from "./types";

export function makeDriverActionRegistry<
  TNode extends object,
  TArgs,
  TDeps extends object,
  TResult,
>(
  actions: Readonly<
    Record<
      string,
      {
        readonly run: DriverActionRun<TNode, TArgs, TDeps, TResult>;
        readonly admission: ActionAdmission;
      }
    >
  >
): DriverActionRegistry<TNode, TArgs, TDeps, TResult> {
  return {
    read: (action) => {
      // Own-key lookup only: a plain record inherits Object.prototype members,
      // so "constructor" or "toString" must not read as declared actions.
      const descriptor = Object.hasOwn(actions, action) ? actions[action] : undefined;
      return descriptor === undefined
        ? { _tag: "Missing", action }
        : { _tag: "Found", run: descriptor.run, admission: descriptor.admission };
    },
  };
}

export function normalizeDriverHook<TAuthor, TRun>(
  hook: TAuthor | undefined,
  normalize: (hook: TAuthor) => TRun
): DriverHook<TRun> {
  return hook === undefined ? { _tag: "Missing" } : { _tag: "Available", run: normalize(hook) };
}
