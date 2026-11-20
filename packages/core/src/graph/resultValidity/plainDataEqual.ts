// Pairs compared before the cycle memo starts. Flat and small results never
// allocate one; a cycle keeps yielding pairs, so it crosses this and ends.
const cycleMemoThreshold = 1024;

/**
 * Compare complete plain values; never share subtrees or equate class
 * instances. Plain data is an ordinary array or an object whose prototype is
 * `Object.prototype` or `null`, holding only data properties. Both sides must
 * share the prototype. Accessors are never invoked and make the values
 * unequal. Any throw (a proxy trap, say) also means unequal: the caller then
 * commits the new value.
 */
export function plainDataEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  try {
    return objectsEqual(left, right);
  } catch {
    return false;
  }
}

function objectsEqual(rootLeft: object, rootRight: object): boolean {
  // Pairs are pushed left then right; an explicit stack keeps deep values off
  // the call stack.
  const stack: object[] = [rootLeft, rootRight];
  let visited = 0;
  let memo: Map<object, Set<object>> | undefined;
  while (stack.length > 0) {
    const right = stack.pop() as object;
    const left = stack.pop() as object;
    if (visited >= cycleMemoThreshold) {
      memo ??= new Map();
      let rights = memo.get(left);
      if (rights === undefined) {
        rights = new Set();
        memo.set(left, rights);
      } else if (rights.has(right)) {
        continue;
      }
      rights.add(right);
    }
    visited += 1;
    if (!samePlainShape(left, right)) return false;
    const keys = Reflect.ownKeys(left);
    if (keys.length !== Reflect.ownKeys(right).length) return false;
    for (const key of keys) {
      const leftSlot = Object.getOwnPropertyDescriptor(left, key);
      const rightSlot = Object.getOwnPropertyDescriptor(right, key);
      if (
        leftSlot === undefined ||
        rightSlot === undefined ||
        !("value" in leftSlot) ||
        !("value" in rightSlot) ||
        leftSlot.enumerable !== rightSlot.enumerable ||
        leftSlot.writable !== rightSlot.writable ||
        leftSlot.configurable !== rightSlot.configurable
      )
        return false;
      const leftValue: unknown = leftSlot.value;
      const rightValue: unknown = rightSlot.value;
      if (Object.is(leftValue, rightValue)) continue;
      if (
        typeof leftValue !== "object" ||
        leftValue === null ||
        typeof rightValue !== "object" ||
        rightValue === null
      )
        return false;
      stack.push(leftValue, rightValue);
    }
  }
  return true;
}

function samePlainShape(left: object, right: object): boolean {
  const prototype = Object.getPrototypeOf(left);
  if (prototype !== Object.getPrototypeOf(right)) return false;
  if (Object.isExtensible(left) !== Object.isExtensible(right)) return false;
  const array = Array.isArray(left);
  if (array !== Array.isArray(right)) return false;
  return array
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}
