import { expect, test } from "bun:test";
import { prepareCommittedResult } from "../src/node/committedResult";

for (const development of [false, true]) {
  test(`missed rows compute one fingerprint: development=${development}`, () => {
    const before = prepareCommittedResult(
      { rows: [{ id: 0 }, { id: 1 }, { id: 2 }] },
      undefined,
      false,
      development
    ) as { rows: object[] };
    const passes = [0, 0, 0];
    const rows = [2, 1, 0].map(
      (id, position) =>
        new Proxy(
          { id },
          {
            ownKeys(target) {
              if (new Error().stack?.includes("rowFingerprint")) {
                passes[position] = (passes[position] ?? 0) + 1;
              }
              return Reflect.ownKeys(target);
            },
          }
        )
    );
    const after = prepareCommittedResult({ rows }, before, true, development) as { rows: object[] };
    expect(passes).toEqual([1, 0, 1]);
    expect(after.rows[0]).toBe(before.rows[2]);
    expect(after.rows[2]).toBe(before.rows[0]);
  });

  test(`proxy fingerprint failures remain visible: development=${development}`, () => {
    const before = prepareCommittedResult(
      { rows: [{ id: 0 }, { id: 1 }] },
      undefined,
      false,
      development
    );
    const sentinel = new Error("proxy fingerprint failed");
    const row = new Proxy(
      { id: 1 },
      {
        ownKeys(target) {
          if (new Error().stack?.includes("rowFingerprint")) throw sentinel;
          return Reflect.ownKeys(target);
        },
      }
    );
    let caught: unknown;
    try {
      prepareCommittedResult({ rows: [row, { id: 0 }] }, before, true, development);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
  });
}

for (const development of [false, true]) {
  test(`function fields never run coercion hooks: development=${development}`, () => {
    const invoke = Object.setPrototypeOf(() => 1, null);
    const prepared = prepareCommittedResult(
      { rows: [{ invoke }, { invoke }] },
      undefined,
      false,
      development
    ) as { rows: Array<{ invoke: unknown }> };
    expect(prepared.rows[0]?.invoke).toBe(invoke);
  });

  test(`moved rows with functions keep identity when coercion changes: development=${development}`, () => {
    let label = "first";
    const first = () => 1;
    const second = () => 2;
    first.toString = () => label;
    const before = prepareCommittedResult(
      {
        rows: [
          { id: 0, run: first },
          { id: 1, run: second },
        ],
      },
      undefined,
      false,
      development
    ) as { rows: object[] };
    label = "changed";
    const after = prepareCommittedResult(
      {
        rows: [
          { id: 1, run: second },
          { id: 0, run: first },
        ],
      },
      before,
      true,
      development
    ) as { rows: object[] };
    expect(after.rows[0]).toBe(before.rows[1]);
    expect(after.rows[1]).toBe(before.rows[0]);
  });
}
