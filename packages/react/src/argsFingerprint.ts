import { Key } from "@frondruntime/core";

export function getReactArgsFingerprint(value: unknown): string {
  return `canonical:${Key.canonicalArgs(value)}`;
}
