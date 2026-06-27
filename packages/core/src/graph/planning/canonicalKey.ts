import { canonicalKey as canonicalKeyString } from "../../keys";
import type { NodeKey } from "../types";

export function canonicalKey(value: unknown): NodeKey {
  return canonicalKeyString(value) as NodeKey;
}
