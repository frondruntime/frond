import { describe, expect, test } from "bun:test";
import { createRuntimeCoordinator, RuntimeBootSupersededError, type RuntimeLease } from "../src";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type TrackedLease = {
  lease: RuntimeLease<string>;
  disposeCount: () => number;
};

function trackedLease(value: string, log: string[], disposeGate?: Promise<void>): TrackedLease {
  let disposals = 0;
  return {
    lease: {
      value,
      dispose: async () => {
        disposals += 1;
        log.push(`dispose:${value}:begin`);
        if (disposeGate !== undefined) {
          await disposeGate;
        }
        log.push(`dispose:${value}:end`);
      },
    },
    disposeCount: () => disposals,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected the promise to reject");
  } catch (cause) {
    return cause;
  }
}

async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("runtime coordinator", () => {
  test("boot, dispose, then boot a replacement generation", async () => {
    const log: string[] = [];
    const coordinator = createRuntimeCoordinator<string>();
    const first = trackedLease("a", log);
    const second = trackedLease("b", log);

    expect(await coordinator.start(async () => first.lease)).toBe("a");
    await coordinator.dispose();
    expect(first.disposeCount()).toBe(1);

    expect(await coordinator.start(async () => second.lease)).toBe("b");
    expect(second.disposeCount()).toBe(0);
    expect(log).toEqual(["dispose:a:begin", "dispose:a:end"]);
  });

  test("start while a runtime is active rejects without touching the active lease", async () => {
    const coordinator = createRuntimeCoordinator<string>();
    const active = trackedLease("a", []);

    expect(await coordinator.start(async () => active.lease)).toBe("a");

    const rejection = await rejectionOf(coordinator.start(async () => trackedLease("b", []).lease));
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(RuntimeBootSupersededError);
    expect((rejection as Error).message).toContain("already active");
    expect(active.disposeCount()).toBe(0);
  });

  test("a second start supersedes a mid-boot first start", async () => {
    const log: string[] = [];
    const coordinator = createRuntimeCoordinator<string>();
    const first = trackedLease("a", log);
    const second = trackedLease("b", log);
    const bootGate = deferred<void>();

    const firstBoot = coordinator.start(async () => {
      log.push("create:a");
      await bootGate.promise;
      return first.lease;
    });
    const secondBoot = coordinator.start(async () => {
      log.push("create:b");
      return second.lease;
    });
    const firstRejection = rejectionOf(firstBoot);

    bootGate.resolve();

    const rejection = await firstRejection;
    expect(rejection).toBeInstanceOf(RuntimeBootSupersededError);
    expect((rejection as RuntimeBootSupersededError)._tag).toBe("RuntimeBootSupersededError");

    expect(await secondBoot).toBe("b");
    // The superseded boot disposed its own lease, fully, before the
    // replacement generation was constructed.
    expect(first.disposeCount()).toBe(1);
    expect(second.disposeCount()).toBe(0);
    expect(log).toEqual(["create:a", "dispose:a:begin", "dispose:a:end", "create:b"]);
  });

  test("dispose during boot supersedes the boot and disposes its lease", async () => {
    const log: string[] = [];
    const coordinator = createRuntimeCoordinator<string>();
    const first = trackedLease("a", log);
    const bootGate = deferred<void>();

    const boot = coordinator.start(async () => {
      await bootGate.promise;
      return first.lease;
    });
    const disposal = coordinator.dispose();
    const bootRejection = rejectionOf(boot);

    bootGate.resolve();

    expect(await bootRejection).toBeInstanceOf(RuntimeBootSupersededError);
    await disposal;
    expect(first.disposeCount()).toBe(1);
    expect(log).toEqual(["dispose:a:begin", "dispose:a:end"]);
  });

  test("dispose is idempotent", async () => {
    const coordinator = createRuntimeCoordinator<string>();

    // Disposing a coordinator that never started resolves.
    await coordinator.dispose();

    const first = trackedLease("a", []);
    await coordinator.start(async () => first.lease);

    await coordinator.dispose();
    await coordinator.dispose();
    await Promise.all([coordinator.dispose(), coordinator.dispose()]);
    expect(first.disposeCount()).toBe(1);
  });

  test("the transition chain serializes overlapping start and dispose calls", async () => {
    const log: string[] = [];
    const coordinator = createRuntimeCoordinator<string>();
    const disposeGate = deferred<void>();
    const first = trackedLease("a", log, disposeGate.promise);
    const second = trackedLease("b", log);

    await coordinator.start(async () => first.lease);

    const disposal = coordinator.dispose();
    const replacementBoot = coordinator.start(async () => {
      log.push("create:b");
      return second.lease;
    });

    // While the previous disposal is pending, the replacement must not begin
    // constructing: no interleaved construction before disposal settles.
    await flushMicrotasks();
    expect(log).toEqual(["dispose:a:begin"]);

    disposeGate.resolve();

    expect(await replacementBoot).toBe("b");
    await disposal;
    expect(log).toEqual(["dispose:a:begin", "dispose:a:end", "create:b"]);
    expect(first.disposeCount()).toBe(1);
  });
});
