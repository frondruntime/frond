import type * as Frond from "@frondruntime/core";
import { getReactArgsFingerprint, validatedNodeIdResolver } from "./argsFingerprint";
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

export function prepareReactNodeMap(input: {
  readonly hook: string;
  readonly runtime: ReactNodeRuntime;
  readonly map: ReactNodeInputMap;
}): PreparedReactNodeMap {
  const entries: Array<PreparedReactNodeMapEntry> = [];
  const keys = Object.keys(input.map).sort();
  let identity = "";
  let argsIdentity = "";
  const resolveValidated = validatedNodeIdResolver(input.runtime);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const entry = input.map[key];

    if (entry === undefined) {
      throw new FrondReactUsageError({
        hook: input.hook,
        message: `FrondReact.${input.hook} missing node entry for key '${key}'.`,
      });
    }

    const [spec, args] = entry;
    // One canonicalization per entry on a runtime from `createRuntime`: the
    // fingerprint validates args, then resolution skips its own pass.
    const validatedFingerprint =
      resolveValidated === undefined ? undefined : getReactArgsFingerprint(args);
    const nodeId =
      resolveValidated === undefined
        ? input.runtime.resolveNodeIdSync({ spec, args })
        : resolveValidated({ spec, args });
    const argsFingerprint = validatedFingerprint ?? getReactArgsFingerprint(args);
    const preparedEntry = {
      key,
      spec,
      args,
      nodeId,
      argsFingerprint,
    };

    entries.push(preparedEntry);
    const separator = index === 0 ? "" : "|";
    identity += `${separator}${key}:${nodeId}`;
    argsIdentity += `${separator}${key}:${nodeId}:${argsFingerprint}`;
  }

  return {
    entries,
    keys,
    identity,
    argsIdentity,
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

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}
