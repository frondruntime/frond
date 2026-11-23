import { runInAction } from "mobx";
import type { ResultPatchOptions } from "../driver/types";
import type { GraphNodeCell } from "../graph/cell/cellModel";
import { clonePatchableResult } from "../graph/driverExecution/patchResultClone";
import { isFrondFrozen, markDraftCopy, plainShape } from "./resultData";

type Container = Record<PropertyKey, unknown>;
interface DraftNode {
  readonly base: Container;
  readonly proxy: Container;
  readonly children: Map<PropertyKey, unknown>;
  readonly keys: Set<PropertyKey>;
  copy: Container | undefined;
}

function shallowCopy(base: Container): Container {
  const copy = (Array.isArray(base) ? base.slice() : { ...base }) as Container;
  for (const key of Object.getOwnPropertySymbols(base)) {
    const descriptor = Object.getOwnPropertyDescriptor(base, key);
    if (descriptor !== undefined) Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

export function stageResultDraft(
  base: unknown,
  recipe: (current: unknown) => unknown,
  returnsResult: boolean,
  options: ResultPatchOptions | undefined,
  context: GraphNodeCell
): { readonly value: unknown } {
  const drafts = new WeakMap<object, DraftNode>();
  const revokes: Array<() => void> = [];
  const normalized = new WeakSet<object>();
  const finalized = new WeakMap<object, unknown>();

  function normalize(value: unknown, path = new Map<object, unknown>()): unknown {
    if (typeof value !== "object" || value === null) return value;
    const node = drafts.get(value);
    if (node !== undefined) return finish(node);
    if (isFrondFrozen(value) || normalized.has(value) || plainShape(value) === undefined)
      return value;
    if (path.has(value)) return path.get(value);
    // New data may embed drafts. Never mutate the author's object.
    const copy = shallowCopy(value as Container);
    path.set(value, copy);
    for (const key of Object.keys(copy)) copy[key] = normalize(copy[key], path);
    normalized.add(copy);
    return copy;
  }

  function finish(node: DraftNode): unknown {
    if (finalized.has(node.proxy)) return finalized.get(node.proxy);
    if (node.copy === undefined) return normalize(node.base);
    const copy = node.copy;
    finalized.set(node.proxy, copy);
    // Newly assigned containers may hold drafts even in fields this recipe
    // did not write. Finalize those fields too, without walking committed data.
    const keys =
      isFrondFrozen(node.base) || normalized.has(node.base) ? node.keys : Object.keys(copy);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(copy, key) && typeof key !== "symbol") {
        copy[key] = normalize(copy[key]);
      }
    }
    normalized.add(copy);
    return copy;
  }

  function draft(source: unknown, changed: (value: unknown) => void): unknown {
    if (plainShape(source) === undefined) {
      return clonePatchableResult(source, options, context);
    }
    const baseContainer = source as Container;
    let node: DraftNode;
    function copyForWrite(key: PropertyKey): Container {
      if (node.copy === undefined) {
        node.copy = shallowCopy(node.base);
        if (isFrondFrozen(node.base)) markDraftCopy(node.copy);
        changed(node.proxy);
      }
      node.keys.add(key);
      return node.copy;
    }
    function write(key: PropertyKey, value: unknown): void {
      const copy = copyForWrite(key);
      const oldLength = Array.isArray(copy) ? copy.length : 0;
      if (!Reflect.set(copy, key, value)) {
        throw new TypeError(`Cannot write result draft property ${String(key)}`);
      }
      if (Array.isArray(copy) && key === "length") {
        // Truncation deletes indices even if the recipe later restores length.
        for (let index = copy.length; index < oldLength; index += 1) {
          node.keys.add(String(index));
          node.children.delete(String(index));
        }
      }
    }
    const revocable = Proxy.revocable((Array.isArray(source) ? [] : {}) as Container, {
      get(_target, key) {
        const current = node.copy ?? node.base;
        const entry = Reflect.get(current, key);
        if (typeof key === "symbol" || typeof entry !== "object" || entry === null) return entry;
        if (drafts.has(entry)) return entry;
        if (node.children.has(key)) return node.children.get(key);
        const child = draft(entry, (value) => {
          if (node.children.get(key) === value) write(key, value);
        });
        node.children.set(key, child);
        if (!drafts.has(child as object) && !Object.is(child, entry)) write(key, child);
        return child;
      },
      set(_target, key, value) {
        const current = node.copy ?? node.base;
        const original =
          typeof value === "object" && value !== null ? drafts.get(value) : undefined;
        const comparable = original?.copy === undefined ? (original?.base ?? value) : value;
        if (
          Object.prototype.hasOwnProperty.call(current, key) &&
          Object.is(current[key], comparable)
        )
          return true;
        node.children.delete(key);
        write(key, value);
        return true;
      },
      deleteProperty(_target, key) {
        if (!Object.prototype.hasOwnProperty.call(node.copy ?? node.base, key)) return true;
        const copy = copyForWrite(key);
        node.children.delete(key);
        return Reflect.deleteProperty(copy, key);
      },
      has(_target, key) {
        return key in (node.copy ?? node.base);
      },
      ownKeys() {
        return Reflect.ownKeys(node.copy ?? node.base);
      },
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Object.getOwnPropertyDescriptor(node.copy ?? node.base, key);
        if (descriptor === undefined) return undefined;
        return {
          ...descriptor,
          writable: true,
          configurable: key !== "length" || !Array.isArray(source),
        };
      },
    });
    node = {
      base: baseContainer,
      proxy: revocable.proxy,
      children: new Map(),
      keys: new Set(),
      copy: undefined,
    };
    drafts.set(node.proxy, node);
    revokes.push(revocable.revoke);
    return node.proxy;
  }

  try {
    const draftBase = normalize(base);
    const current = draft(draftBase, () => {});
    const returned = runInAction(() => recipe(current));
    const value = normalize(returnsResult ? returned : current);
    return { value };
  } finally {
    for (const revoke of revokes) revoke();
  }
}
