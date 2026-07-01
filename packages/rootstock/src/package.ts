export const RootstockPackageStatus = {
  Experimental: "experimental",
} as const;

export type RootstockPackageStatusValue =
  (typeof RootstockPackageStatus)[keyof typeof RootstockPackageStatus];

export interface RootstockPackageInfo {
  readonly name: "@frondruntime/rootstock";
  readonly status: RootstockPackageStatusValue;
}

export const rootstockPackageInfo = {
  name: "@frondruntime/rootstock",
  status: RootstockPackageStatus.Experimental,
} as const satisfies RootstockPackageInfo;
