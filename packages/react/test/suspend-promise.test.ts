import { expect, test } from "bun:test";
import { compositeSuspendPromise, suspendPromise } from "../src/suspendPromise";

test("readiness wrappers share core attempt identity and fulfill on success or failure", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const core = Promise.withResolvers<unknown>();
    const wrapper = suspendPromise(core.promise);
    expect(suspendPromise(core.promise)).toBe(wrapper);
    expect(wrapper.status).toBe("pending");
    if (outcome === "success") core.resolve("ready");
    else core.reject(new Error("readiness failure"));
    expect(await wrapper).toBeUndefined();
    expect(wrapper.status).toBe("fulfilled");
    expect(wrapper.value).toBeUndefined();
    expect(suspendPromise(core.promise)).toBe(wrapper);
  }
});

test("a known settled attempt creates an already fulfilled wrapper", async () => {
  for (const status of ["fulfilled", "rejected"] as const) {
    const source = Object.assign(
      status === "fulfilled" ? Promise.resolve() : Promise.reject(new Error("failed")),
      { status }
    );
    const wrapper = suspendPromise(source);
    expect(wrapper.status).toBe("fulfilled");
    expect(wrapper.value).toBeUndefined();
    await wrapper;
  }
});

test("composites cache a child set across order changes, duplicate entries, and settlement", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const left = suspendPromise(first.promise);
  const right = suspendPromise(second.promise);
  const composite = compositeSuspendPromise([left, right]);
  expect(compositeSuspendPromise([right, left, right])).toBe(composite);
  expect(composite.status).toBe("pending");
  first.resolve();
  await left;
  expect(composite.status).toBe("pending");
  second.reject(new Error("failed sibling"));
  await composite;
  expect(composite.status).toBe("fulfilled");
  expect(composite.value).toBeUndefined();
  expect(compositeSuspendPromise([left, right])).toBe(composite);
  expect(compositeSuspendPromise([left])).not.toBe(composite);
});

test("a new composite of settled children is fulfilled before its first read", async () => {
  const first = suspendPromise(Promise.resolve());
  const second = suspendPromise(Promise.resolve());
  await Promise.all([first, second]);
  const composite = compositeSuspendPromise([first, second]);
  expect(composite.status).toBe("fulfilled");
  expect(composite.value).toBeUndefined();
  await composite;
});
