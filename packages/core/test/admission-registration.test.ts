import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import type { GraphCellTask } from "../src/graph/cell/cellActor";
import { registerAdmittedTask } from "../src/graph/system/admissionRegistration";

describe("admission registration", () => {
  test("interruption after start cannot strand an unsettled placeholder", async () => {
    const active = new Map<string, GraphCellTask<string>>();
    const firstTask = { await: Effect.succeed("first") } satisfies GraphCellTask<string>;
    const secondTask = { await: Effect.succeed("second") } satisfies GraphCellTask<string>;

    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* registerAdmittedTask({
          active,
          key: "same",
          start: () =>
            Effect.withFiber((parent) =>
              Effect.forkDetach({ startImmediately: true })(Fiber.interrupt(parent)).pipe(
                Effect.as(firstTask)
              )
            ),
        }).pipe(Effect.forkDetach);

        yield* Fiber.await(first);

        const joined = active.get("same");
        if (joined === undefined) {
          throw new Error("Expected the admitted task to remain registered.");
        }
        const firstResult = yield* joined.await.pipe(Effect.timeout("200 millis"));
        expect(firstResult).toBe("first");
        active.delete("same");

        const second = yield* registerAdmittedTask({
          active,
          key: "same",
          start: () => Effect.succeed(secondTask),
        }).pipe(Effect.timeout("200 millis"));
        const result = yield* second.await.pipe(Effect.timeout("200 millis"));

        expect(result).toBe("second");
      })
    );
  });
});
