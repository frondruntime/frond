import type * as Frond from "@frondruntime/core";
import * as FrondReact from "@frondruntime/react";
import * as FrondReactTesting from "@frondruntime/react/testing";
import type * as React from "react";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type Expect<TValue extends true> = TValue;

FrondReact.Preload satisfies <const TLayers extends ReadonlyArray<FrondReact.ReactNodeInputMap>>(
  props: FrondReact.PreloadProps<TLayers>
) => React.ReactNode;

FrondReact.useNodeState satisfies (
  spec: Frond.NodeSpecLike,
  args: Frond.NodeSpecArgs<Frond.NodeSpecLike>
) => FrondReact.UseNodeState<Frond.NodeSpecLike>;

FrondReact.useNodesControls satisfies <const TMap extends FrondReact.ReactNodeInputMap>(
  map: TMap & FrondReact.CheckedReactNodeInputMap<TMap>
) => FrondReact.UseNodesControls<TMap>;

FrondReact.getErrorReport satisfies (error: unknown) => FrondReact.FrondReactErrorReport;

export type NoFrondPreload = Expect<
  Equal<"FrondPreload" extends keyof typeof FrondReact ? true : false, false>
>;

export type NoUseNodeResult = Expect<
  Equal<"UseNodeResult" extends keyof typeof FrondReact ? true : false, false>
>;
export type NoTestingKeyGuard = Expect<
  Equal<"assertStableKeySet" extends keyof typeof FrondReactTesting ? true : false, false>
>;

// @ts-expect-error Preload is canonical; FrondPreload is not exported.
FrondReact.FrondPreload;

// @ts-expect-error PreloadProps is canonical; FrondPreloadProps is not exported.
export type NoFrondPreloadProps = FrondReact.FrondPreloadProps<[]>;

// @ts-expect-error UseNodeState is canonical; UseNodeResult is not exported.
export type NoUseNodeResultType = FrondReact.UseNodeResult<Frond.NodeSpecLike>;

// @ts-expect-error Key-set guard is internal to the hook implementation.
FrondReactTesting.assertStableKeySet;

FrondReactTesting.TestFrondProvider satisfies (props: {
  readonly runtime?: Frond.Runtime.Runtime | undefined;
  readonly children: React.ReactNode;
}) => React.ReactNode;
