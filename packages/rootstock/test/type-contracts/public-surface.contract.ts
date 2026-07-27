import * as Rootstock from "@frondruntime/rootstock";
import * as RootstockTesting from "@frondruntime/rootstock/testing";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

Rootstock.rootstockPackageInfo satisfies Rootstock.RootstockPackageInfo;
RootstockTesting.rootstockTestLabel("surface") satisfies string;

export type RootstockPackageNameIsLiteral = Expect<
  Equal<typeof Rootstock.rootstockPackageInfo.name, "@frondruntime/rootstock">
>;

export type RootstockStatusIsExperimental = Expect<
  Equal<Rootstock.RootstockPackageStatusValue, "experimental">
>;
