import type { KeyInput } from "./key";

declare const KEY_BRAND: unique symbol;

export type Key<TValue extends KeyInput = KeyInput> = TValue & {
  readonly [KEY_BRAND]: "Frond.Key";
};

export type Singleton = Key<"singleton">;

export type Structure<TValue extends KeyInput> = Key<TValue>;

/**
 * Returns the singleton key for specs with exactly one graph identity.
 */
export function singleton(): Singleton {
  return "singleton" as Singleton;
}

/**
 * Brands a JSON-shaped structural key.
 *
 * Use stable, serializable values only. Runtime identity depends on canonical
 * key equality, not object reference equality.
 */
export function structure<TValue extends KeyInput>(value: TValue): Structure<TValue> {
  return value as Structure<TValue>;
}

export const Key = {
  singleton,
  structure,
} as const;
