import { expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import * as Frond from "../src";
import { makeRuntimeHost } from "../src/runtime/host";
import { FrondRuntimeEffect } from "../src/runtime/live";

const invalidOptions: ReadonlyArray<unknown> = [
  undefined,
  null,
  false,
  512,
  "512",
  1n,
  Symbol("options"),
  () => {},
];

for (const options of invalidOptions) {
  test(`createRuntime rejects non-object options: ${String(options)}`, () => {
    expect(() => Frond.createRuntime(options as Frond.Runtime.RuntimeOptions)).toThrow(
      Frond.Runtime.FrondRuntimeInvariantViolation
    );
  });
  for (const create of [makeRuntimeHost, FrondRuntimeEffect]) {
    test(`${create.name} rejects non-object options: ${String(options)}`, () => {
      const exit = Effect.runSyncExit(create(options as Frond.Runtime.RuntimeOptions));
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") throw new Error("Expected invalid runtime options to fail");
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Frond.Runtime.FrondRuntimeInvariantViolation);
    });
  }
}

test("invalid string limits are quoted in runtime invariant messages", () => {
  expect(() =>
    Frond.createRuntime({
      development: false,
      eventBufferSize: "512",
    } as unknown as Frond.Runtime.RuntimeOptions)
  ).toThrow('received "512"');
});
