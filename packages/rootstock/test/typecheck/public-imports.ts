import * as Rootstock from "@frondruntime/rootstock";
import * as RootstockTesting from "@frondruntime/rootstock/testing";

Rootstock.rootstockPackageInfo satisfies Rootstock.RootstockPackageInfo;
RootstockTesting.rootstockTestLabel("imports") satisfies string;
