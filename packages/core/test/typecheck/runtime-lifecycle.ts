import { createRuntime, FrondRuntimeClosed } from "../../src/runtime";
import { Signals } from "../../src/signals";

export async function runtimeLifecycleTypeSmoke(): Promise<void> {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });

  await runtime.submit({ _tag: "RuntimeStart" });
  await runtime.submit({ _tag: "RuntimeStop", reason: "type smoke" });

  await runtime
    .publish(Signals.signal({ channel: "runtime/type-smoke", name: "after-stop" }))
    .catch((error: unknown) => {
      if (!(error instanceof FrondRuntimeClosed)) {
        throw error;
      }
    });
}
