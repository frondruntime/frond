import type * as Frond from "@frondruntime/core";
import { getReactArgsFingerprint } from "./argsFingerprint";
import { FrondReactUsageError } from "./errors";
import type { ReactNodeInputMap, ReactNodeRuntime } from "./types";

export interface ReactNodeMapEntry {
  readonly key: string;
  readonly spec: unknown;
  readonly args: unknown;
  readonly nodeId: Frond.Graph.NodeId;
}

export interface PreparedReactNodeMapEntry extends ReactNodeMapEntry {
  readonly argsFingerprint: string;
}

export interface PreparedReactNodeMap {
  readonly entries: ReadonlyArray<PreparedReactNodeMapEntry>;
  readonly keys: ReadonlyArray<string>;
  readonly identity: string;
  readonly argsIdentity: string;
}

export function reactNodeMapEntries(input: {
  readonly hook: string;
  readonly runtime: ReactNodeRuntime;
  readonly map: ReactNodeInputMap;
}): ReadonlyArray<ReactNodeMapEntry> {
  return Object.keys(input.map)
    .sort()
    .map((key) => {
      const entry = input.map[key];

      if (entry === undefined) {
        throw new FrondReactUsageError({
          hook: input.hook,
          message: `FrondReact.${input.hook} missing node entry for key '${key}'.`,
        });
      }

      const [spec, args] = entry;
      return {
        key,
        spec,
        args,
        nodeId: input.runtime.resolveNodeIdSync({ spec, args }),
      };
    });
}

export function prepareReactNodeMap(input: {
  readonly hook: string;
  readonly runtime: ReactNodeRuntime;
  readonly map: ReactNodeInputMap;
}): PreparedReactNodeMap {
  const entries: Array<PreparedReactNodeMapEntry> = [];
  const keys = Object.keys(input.map).sort();
  const identityParts: Array<string> = [];
  const argsIdentityParts: Array<string> = [];

  for (const key of keys) {
    const entry = input.map[key];

    if (entry === undefined) {
      throw new FrondReactUsageError({
        hook: input.hook,
        message: `FrondReact.${input.hook} missing node entry for key '${key}'.`,
      });
    }

    const [spec, args] = entry;
    const nodeId = input.runtime.resolveNodeIdSync({ spec, args });
    const argsFingerprint = getReactArgsFingerprint(args);
    const preparedEntry = {
      key,
      spec,
      args,
      nodeId,
      argsFingerprint,
    };

    entries.push(preparedEntry);
    identityParts.push(`${key}:${nodeId}`);
    argsIdentityParts.push(`${key}:${nodeId}:${argsFingerprint}`);
  }

  return {
    entries,
    keys,
    identity: identityParts.join("|"),
    argsIdentity: argsIdentityParts.join("|"),
  };
}

export function assertStableKeySet(input: {
  readonly hook: string;
  readonly initialKeys: { current: ReadonlyArray<string> | undefined };
  readonly nextKeys: ReadonlyArray<string>;
}): void {
  if (input.initialKeys.current === undefined) {
    input.initialKeys.current = [...input.nextKeys];
    return;
  }

  if (sameKeys(input.initialKeys.current, input.nextKeys)) {
    return;
  }

  throw new FrondReactUsageError({
    hook: input.hook,
    message: `FrondReact.${input.hook} key set changed across renders: was [${input.initialKeys.current.join(
      ", "
    )}], now [${input.nextKeys.join(", ")}].`,
  });
}

function sameKeys(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => entry === right[index]);
}
