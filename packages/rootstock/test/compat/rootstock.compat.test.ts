import { expect, test } from "bun:test";
import {
  type RootstockPackageInfo,
  RootstockPackageStatus,
  type RootstockPackageStatusValue,
  rootstockPackageInfo,
} from "@frondruntime/rootstock";
import {
  rootstockTestLabel,
  rootstockPackageInfo as testingPackageInfo,
} from "@frondruntime/rootstock/testing";

test("Rootstock exposes experimental package metadata from both public entries", () => {
  const information: RootstockPackageInfo = rootstockPackageInfo;
  const status: RootstockPackageStatusValue = RootstockPackageStatus.Experimental;
  expect(status).toBe("experimental");
  expect(information).toEqual({ name: "@frondruntime/rootstock", status });
  expect(testingPackageInfo).toBe(rootstockPackageInfo);
});

test("Rootstock test labels prefix names without normalizing their contents", () => {
  expect(rootstockTestLabel("orders")).toBe("rootstock:orders");
  expect(rootstockTestLabel("")).toBe("rootstock:");
  expect(rootstockTestLabel(" account:regional ")).toBe("rootstock: account:regional ");
});
