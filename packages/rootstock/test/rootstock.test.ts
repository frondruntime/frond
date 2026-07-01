import { expect, test } from "bun:test";
import { RootstockPackageStatus, rootstockPackageInfo } from "../src";
import { rootstockTestLabel } from "../src/testing";

test("exposes package status", () => {
  expect(rootstockPackageInfo).toEqual({
    name: "@frondruntime/rootstock",
    status: RootstockPackageStatus.Experimental,
  });
});

test("exposes testing helpers", () => {
  expect(rootstockTestLabel("catalog")).toBe("rootstock:catalog");
});
