import { Effect, Layer } from "effect";
import { makeRuntimeHost } from "./host";
import { FrondRuntime, type RuntimeOptions } from "./types";

export const FrondRuntimeLive = (options: RuntimeOptions = {}): Layer.Layer<FrondRuntime> =>
  Layer.effect(FrondRuntime)(
    Effect.gen(function* () {
      const host = yield* makeRuntimeHost(options);
      yield* Effect.addFinalizer(() =>
        host.submit({ _tag: "RuntimeStop", reason: "runtime scope closed" }).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.asVoid
        )
      );
      return FrondRuntime.of(host);
    })
  );

export const FrondRuntimeEffect = (options: RuntimeOptions = {}) => {
  return makeRuntimeHost(options).pipe(Effect.map((host) => FrondRuntime.of(host)));
};
