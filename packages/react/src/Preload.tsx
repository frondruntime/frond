import type { ReactNode } from "react";
import type { CheckedReactNodeInputMap, ReactNodeInputMap } from "./types";
import { useNodes } from "./useNodes";

export interface PreloadProps<TLayers extends ReadonlyArray<ReactNodeInputMap>> {
  readonly nodes: TLayers & {
    readonly [TIndex in keyof TLayers]: CheckedReactNodeInputMap<TLayers[TIndex]>;
  };
  readonly children: ReactNode;
}

/**
 * Boots one or more node layers before rendering children.
 *
 * Use for route-level data requirements. Each layer is a `useNodes` input map;
 * later layers wait until earlier layers are ready.
 */
export function Preload<const TLayers extends ReadonlyArray<ReactNodeInputMap>>({
  nodes,
  children,
}: PreloadProps<TLayers>): ReactNode {
  return nodes.length === 0 ? (
    children
  ) : (
    <PreloadLayers nodes={nodes as ReadonlyArray<ReactNodeInputMap>} index={0}>
      {children}
    </PreloadLayers>
  );
}

interface PreloadLayersProps {
  readonly nodes: ReadonlyArray<ReactNodeInputMap>;
  readonly index: number;
  readonly children?: ReactNode;
}

function PreloadLayers({ nodes, index, children }: PreloadLayersProps): ReactNode {
  const entry = nodes[index];

  return entry === undefined ? (
    children
  ) : (
    <PreloadLayer entry={entry}>
      <PreloadLayers nodes={nodes} index={index + 1}>
        {children}
      </PreloadLayers>
    </PreloadLayer>
  );
}

interface PreloadLayerProps {
  readonly entry: ReactNodeInputMap;
  readonly children?: ReactNode;
}

function PreloadLayer({ entry, children }: PreloadLayerProps): ReactNode {
  useNodes(entry as never);

  return children;
}
