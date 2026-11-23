import { expect, test } from "bun:test";
import { prepareCommittedResult } from "../src/node/committedResult";

type Row = { readonly id: string; readonly name: string; readonly tags?: ReadonlyArray<string> };
const row = (id: string, name = `row ${id}`): Row => ({ id, name });
const fresh = (rows: ReadonlyArray<Row>): Array<Row> => rows.map((entry) => ({ ...entry }));
const commit = (candidate: unknown, previous: unknown) =>
  prepareCommittedResult(candidate, previous, true, true) as { readonly rows: ReadonlyArray<Row> };

function initial(count: number) {
  const rows = Array.from({ length: count }, (_, index) => row(`r${index}`));
  return commit({ rows }, undefined);
}

test("a refresh that prepends keeps every unchanged row object", () => {
  const before = initial(3);
  const after = commit({ rows: [row("new"), ...fresh(before.rows)] }, before);
  expect(after.rows).toHaveLength(4);
  expect(after.rows[1]).toBe(before.rows[0]);
  expect(after.rows[2]).toBe(before.rows[1]);
  expect(after.rows[3]).toBe(before.rows[2]);
});

test("a refresh that removes the first row keeps the rest", () => {
  const before = initial(4);
  const after = commit({ rows: fresh(before.rows.slice(1)) }, before);
  expect(after.rows).toHaveLength(3);
  expect(after.rows[0]).toBe(before.rows[1]);
  expect(after.rows[1]).toBe(before.rows[2]);
  expect(after.rows[2]).toBe(before.rows[3]);
});

test("a refresh that swaps two rows keeps both row objects", () => {
  const before = initial(5);
  const swapped = fresh(before.rows);
  const first = swapped[1];
  const second = swapped[3];
  if (first === undefined || second === undefined) throw new Error("fixture");
  swapped[1] = second;
  swapped[3] = first;
  const after = commit({ rows: swapped }, before);
  expect(after).not.toBe(before);
  expect(after.rows[1]).toBe(before.rows[3]);
  expect(after.rows[3]).toBe(before.rows[1]);
  expect(after.rows[0]).toBe(before.rows[0]);
});

test("a refresh that reverses the rows keeps every row object", () => {
  const before = initial(6);
  const after = commit({ rows: fresh(before.rows).reverse() }, before);
  expect(after).not.toBe(before);
  for (let index = 0; index < 6; index += 1) expect(after.rows[index]).toBe(before.rows[5 - index]);
});

test("a moved row that also changed is a new frozen object", () => {
  const tags = ["a", "b"];
  const before = commit({ rows: [row("r0"), { id: "r1", name: "one", tags }] }, undefined);
  const after = commit(
    { rows: [row("new"), row("r0"), { id: "r1", name: "edited", tags: [...tags] }] },
    before
  );
  expect(after.rows[1]).toBe(before.rows[0]);
  expect(after.rows[2]).not.toBe(before.rows[1]);
  expect(after.rows[2]?.name).toBe("edited");
  expect(Object.isFrozen(after.rows[2])).toBe(true);
});

test("an equal refresh still returns the previous root, and a reorder does not", () => {
  const before = initial(3);
  expect(commit({ rows: fresh(before.rows) }, before)).toBe(before);
  const reordered = commit({ rows: fresh(before.rows).reverse() }, before);
  expect(reordered).not.toBe(before);
  expect(reordered.rows.map((entry) => entry.id)).toEqual(["r2", "r1", "r0"]);
});

test("duplicate equal rows may share one frozen object", () => {
  const before = initial(2);
  const copy = before.rows[0];
  if (copy === undefined) throw new Error("fixture");
  const after = commit({ rows: [row("x"), { ...copy }, { ...copy }] }, before);
  expect(after.rows[1]).toEqual(copy);
  expect(after.rows[2]).toEqual(copy);
  expect(after.rows[1]).toBe(before.rows[0]);
});

test("rows of nested arrays are matched too", () => {
  const before = prepareCommittedResult(
    {
      grid: [
        [1, 2],
        [3, 4],
      ],
    },
    undefined,
    true,
    true
  ) as {
    readonly grid: ReadonlyArray<ReadonlyArray<number>>;
  };
  const after = prepareCommittedResult({ grid: [[0], [1, 2], [3, 4]] }, before, true, true) as {
    readonly grid: ReadonlyArray<ReadonlyArray<number>>;
  };
  expect(after.grid[1]).toBe(before.grid[0]);
  expect(after.grid[2]).toBe(before.grid[1]);
});

function commitInMode<Value>(value: Value, previous: unknown, development: boolean): Value {
  return prepareCommittedResult(value, previous, previous !== undefined, development) as Value;
}

for (const development of [false, true]) {
  test(`fingerprint collisions still compare every candidate: development=${development}`, () => {
    const markers = Array.from({ length: 6 }, () => Symbol("same description"));
    const before = commitInMode(
      { rows: markers.map((marker) => ({ marker })) },
      undefined,
      development
    );
    const after = commitInMode(
      { rows: markers.map((marker) => ({ marker })).reverse() },
      before,
      development
    );
    for (let index = 0; index < 6; index += 1)
      expect(after.rows[index]).toBe(before.rows[5 - index]);
  });
}

for (const development of [false, true]) {
  test(`a single positional miss shares a duplicate row: development=${development}`, () => {
    const before = commitInMode({ rows: [{ id: "a" }, { id: "b" }] }, undefined, development);
    const after = commitInMode({ rows: [{ id: "b" }, { id: "b" }] }, before, development);
    expect(after.rows[0]).toEqual(before.rows[1]);
    expect(after.rows[0]).toBe(before.rows[1]);
  });
  for (const movement of ["reverse", "prepend"] as const) {
    test(`nested rows retain every moved identity: development=${development}/${movement}`, () => {
      const fresh = () => Array.from({ length: 6 }, (_, id) => ({ meta: { id } }));
      const before = commitInMode({ rows: fresh() }, undefined, development);
      const rows = movement === "reverse" ? fresh().reverse() : [{ meta: { id: 99 } }, ...fresh()];
      const after = commitInMode({ rows }, before, development);
      for (let index = 0; index < 6; index += 1) {
        const position = movement === "reverse" ? 5 - index : index + 1;
        expect(after.rows[position]).toBe(before.rows[index]);
      }
    });
  }
}
