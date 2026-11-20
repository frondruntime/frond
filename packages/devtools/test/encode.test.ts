import { describe, expect, test } from "bun:test";
import { Graph, type Runtime } from "@frondruntime/core";
import { Data } from "effect";
import { compact } from "../src/cause.ts";
import { createValueEncoder, encodeRecord } from "../src/encode.ts";
import type { EncodePolicy } from "../src/policy.ts";
import { Ingest } from "../src/protocol.ts";
import { acrossTheWire } from "./wire.ts";

/**
 * Builds a record around one event field.
 *
 * The cast is the point of the helper: `RuntimeEvent` is a closed union of the
 * runtime's own events, and these tests are about the *encoder*, which treats
 * the body as opaque. Constructing a real event of the right shape for each
 * case would test the union, not the walker.
 */
function recordWith(
  value: unknown,
  failures: ReadonlyArray<unknown> = []
): Runtime.RuntimeEventRecord {
  return recordOf({ _tag: "Probe", value }, failures);
}

function recordOf(
  event: unknown,
  failures: ReadonlyArray<unknown> = []
): Runtime.RuntimeEventRecord {
  return {
    runtimeId: "runtime-1",
    sequence: 1,
    recordedAt: 1000,
    work: {
      workId: "work-1",
      parentWorkId: undefined,
      source: "manual",
      reason: "acquire",
      priority: "background",
    },
    event,
    classification: {
      category: "graph",
      severity: "info",
      timeline: "operational",
      reportable: true,
    },
    nodeIds: [],
    failures,
  } as unknown as Runtime.RuntimeEventRecord;
}

function fieldOf(value: unknown, policy: "none" | "shape" | "full"): unknown {
  return encodeRecord(recordWith(value), policy).fields["value"];
}

/** One event field, encoded at `policy` and sent through the transport. */
function crossed(value: unknown, policy: EncodePolicy): unknown {
  const encoded = encodeRecord(recordWith(value), policy);
  const received = acrossTheWire(Ingest.payloadSchema, {
    attachmentId: "attachment-1",
    records: [{ ...encoded, category: "state", timeline: "state", reason: "refresh", workId: 1 }],
    droppedSince: 0,
  });

  return received.records[0]?.fields["value"];
}

describe("encodeRecord", () => {
  test("full keeps nested values instead of describing them", () => {
    const encoded = fieldOf({ user: { id: 7, name: "ada", tags: ["a", "b"] } }, "full");

    expect(encoded).toEqual({ user: { id: 7, name: "ada", tags: ["a", "b"] } });
  });

  test("shape still refuses to descend into values", () => {
    expect(fieldOf({ user: { id: 7, name: "ada" } }, "shape")).toBe("{user}");
  });

  test("none sends no fields at all", () => {
    expect(encodeRecord(recordWith({ secret: 1 }), "none").fields).toEqual({});
  });

  /**
   * The bound that is not a nicety: without it this walker recurses until the
   * stack gives out, inside the app being observed, on its own event loop.
   */
  test("full marks a cycle rather than following it", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;

    expect(fieldOf(cyclic, "full")).toEqual({ name: "root", self: { _: "cycle" } });
  });

  /**
   * A value reachable twice is not a cycle. Marking it as one would blank out
   * legitimately shared structure — the same config object held by two nodes —
   * and read as data loss to anything consuming the feed.
   */
  test("full encodes a shared reference twice rather than calling it a cycle", () => {
    const shared = { id: "shared" };

    expect(fieldOf({ left: shared, right: shared }, "full")).toEqual({
      left: { id: "shared" },
      right: { id: "shared" },
    });
  });

  test("full elides past its depth bound, and says so", () => {
    let deep: Record<string, unknown> = { bottom: true };

    for (let i = 0; i < 30; i += 1) {
      deep = { nested: deep };
    }

    const encoded = JSON.stringify(fieldOf(deep, "full"));

    expect(encoded).toContain(`{"_":"elided","by":"depth"}`);
    // The marker replaces the tail; nothing below the bound leaks past it.
    expect(encoded).not.toContain("bottom");
  });

  test("full reports the real length when it truncates a long array", () => {
    const encoded = fieldOf(
      Array.from({ length: 5000 }, (_, index) => index),
      "full"
    ) as ReadonlyArray<unknown>;

    expect(encoded).toHaveLength(4097);
    expect(encoded[encoded.length - 1]).toEqual({ _: "elided", by: "entries", length: 5000 });
  });

  /**
   * A collection is read through its iterator, which can run the app's code and
   * need never end, so the bound has to stop the reads and not only the output.
   * One step past it says whether anything was cut; none after that runs.
   */
  test("full stops reading a long collection at its bound, and says so", () => {
    const cut = { _: "elided", by: "entries", length: 5000 };
    let steps = 0;

    function counted<T>(source: Iterator<T>): IterableIterator<T> {
      return {
        next: () => {
          steps++;
          return source.next();
        },
        [Symbol.iterator]() {
          return this;
        },
      } as IterableIterator<T>;
    }

    class CountedMap extends Map<number, number> {
      override entries(): MapIterator<[number, number]> {
        return counted(super.entries()) as MapIterator<[number, number]>;
      }
    }

    class CountedSet extends Set<number> {
      override values(): SetIterator<number> {
        return counted(super.values()) as SetIterator<number>;
      }
    }

    const numbers = Array.from({ length: 5000 }, (_, index) => index);
    const map = fieldOf(new CountedMap(numbers.map((index) => [index, index])), "full") as {
      readonly entries: ReadonlyArray<unknown>;
      readonly size: number;
    };

    expect(steps).toBe(4097);
    expect(map.entries).toHaveLength(4097);
    expect(map.entries[4096]).toEqual([cut, cut]);
    expect(map.size).toBe(5000);

    steps = 0;
    const set = fieldOf(new CountedSet(numbers), "full") as {
      readonly values: ReadonlyArray<unknown>;
      readonly size: number;
    };

    expect(steps).toBe(4097);
    expect(set.values).toHaveLength(4097);
    expect(set.values[4096]).toEqual(cut);
    expect(set.size).toBe(5000);
  });

  /** Exactly at the bound nothing was cut, so nothing says it was. */
  test("full marks no cut on a collection exactly at its bound", () => {
    const numbers = Array.from({ length: 4096 }, (_, index) => index);
    const set = fieldOf(new Set(numbers), "full") as { readonly values: ReadonlyArray<unknown> };

    expect(set.values).toHaveLength(4096);
    expect(set.values[4095]).toBe(4095);
  });

  /**
   * An array announces truncation by pushing a marker; an object has nowhere to
   * push one, so it carries the marker as a key. Without it a truncated object
   * is indistinguishable from a complete one, which is the single failure mode
   * these bounds exist to avoid.
   */
  test("full reports the real key count when it truncates a wide object", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`k${index}`, index])
    );

    const encoded = fieldOf(wide, "full") as Record<string, unknown>;

    expect(Object.keys(encoded)).toHaveLength(4097);
    expect(encoded["_elided"]).toEqual({ _: "elided", by: "entries", length: 5000 });
  });

  test("full stops at its per-record budget", () => {
    // Wide *and* shallow: the per-key cap bounds the breadth at 4096, so the
    // budget can only be reached by giving each of those keys a body. Twelve
    // fields apiece puts the walk past 52000 values against a 50000 allowance,
    // with the depth bound nowhere near in play.
    const wide = Object.fromEntries(
      Array.from({ length: 4000 }, (_, index) => [
        `k${index}`,
        Object.fromEntries(Array.from({ length: 12 }, (_, field) => [`f${field}`, field])),
      ])
    );

    expect(JSON.stringify(fieldOf(wide, "full"))).toContain(`{"_":"elided","by":"budget"}`);
  });

  test("two records, and two full encoders, never spend each other's budget", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 4000 }, (_, index) => [
        `k${index}`,
        Object.fromEntries(Array.from({ length: 12 }, (_, field) => [`f${field}`, field])),
      ])
    );
    const small = { user: { id: 7, tags: ["a", "b"] } };

    expect(JSON.stringify(fieldOf(wide, "full"))).toContain(`"by":"budget"`);
    expect(fieldOf(small, "full")).toEqual(small);

    const spent = createValueEncoder("full");
    const fresh = createValueEncoder("full");
    expect(JSON.stringify(spent.value(wide))).toContain(`"by":"budget"`);
    expect(JSON.stringify(spent.value(small))).toContain(`"by":"budget"`);
    expect(fresh.value(small)).toEqual(small);
  });

  test("a record lays out its routing fields, then fields, then failures", () => {
    const failure = new Error("boom");
    const plain = encodeRecord(recordWith(failure, [failure]), "full");
    const signal = encodeRecord(
      recordOf({
        _tag: "RuntimeSignalPublished",
        record: { signal: { channel: "app.analytics", name: "checkout_started" } },
      }),
      "shape"
    );
    const routing = [
      "sequence",
      "recordedAt",
      "tag",
      "category",
      "severity",
      "timeline",
      "reportable",
      "workId",
      "parentWorkId",
      "source",
      "reason",
      "priority",
      "nodeIds",
    ];

    expect(Object.keys(plain)).toEqual([...routing, "fields", "failures"]);
    expect(Object.keys(signal)).toEqual([...routing, "channel", "name", "fields", "failures"]);
    expect(plain.fields["value"]).toEqual(plain.failures[0] as never);
  });

  test("full keeps an error's message and stack", () => {
    const encoded = fieldOf(new TypeError("boom"), "full") as Record<string, unknown>;
    const frames = encoded["causes"] as ReadonlyArray<Record<string, unknown>>;

    expect(encoded["message"]).toBe("boom");
    expect(frames[0]?.["name"]).toBe("TypeError");
    expect(typeof frames[0]?.["stack"]).toBe("string");
  });

  test("full names the class of an instance alongside its fields", () => {
    class Session {
      readonly id = "s-1";
    }

    expect(fieldOf(new Session(), "full")).toEqual({ id: "s-1", _type: "Session" });
  });

  test("full encodes maps and sets, which JSON alone turns into empty objects", () => {
    expect(fieldOf(new Map([["a", 1]]), "full")).toEqual({
      _: "map",
      entries: [["a", 1]],
      size: 1,
    });
    expect(fieldOf(new Set([1, 2]), "full")).toEqual({ _: "set", values: [1, 2], size: 2 });
  });
});

/**
 * The failure these exist for: a publication is one field, `record`, so the
 * uniform field walk reduced the whole event to
 * `"{runtimeId,sequence,recordedAt,signal}"` — a feed that says a signal fired
 * and withholds every part of it a reader came for.
 */
describe("a signal's identity", () => {
  const signalRecord = {
    runtimeId: "runtime-1",
    sequence: 4,
    recordedAt: 1000,
    signal: {
      channel: "app.analytics",
      name: "checkout_started",
      payload: { orderId: "order-4417" },
    },
  };

  const published = (): Runtime.RuntimeEventRecord =>
    recordOf({ _tag: "RuntimeSignalPublished", record: signalRecord, at: 1000 });

  test("the channel and the name cross at every policy", () => {
    for (const policy of ["none", "shape", "full"] as const) {
      const encoded = encodeRecord(published(), policy);

      expect([encoded.channel, encoded.name]).toEqual(["app.analytics", "checkout_started"]);
    }
  });

  /**
   * Lifting the routing fields out is not a licence for the payload to follow
   * them: it is app data, and which policy applies to it did not change.
   */
  test("the payload is still clamped by the policy", () => {
    expect(encodeRecord(published(), "none").fields).toEqual({});
    expect(encodeRecord(published(), "shape").fields["record"]).toBe(
      "{runtimeId,sequence,recordedAt,signal}"
    );

    expect(JSON.stringify(encodeRecord(published(), "none"))).not.toContain("order-4417");
    expect(JSON.stringify(encodeRecord(published(), "shape"))).not.toContain("order-4417");
    expect(JSON.stringify(encodeRecord(published(), "full"))).toContain("order-4417");
  });

  /** A subscriber failure that cannot say which signal it was on has no subject. */
  test("a subscriber failure names the signal it was handling", () => {
    const encoded = encodeRecord(
      recordOf(
        {
          _tag: "RuntimeSignalSubscriberFailureObserved",
          subscriber: "audit-log",
          signal: signalRecord,
          cause: new Error("subscriber threw"),
          at: 1000,
        },
        [new Error("subscriber threw")]
      ),
      "shape"
    );

    expect([encoded.channel, encoded.name]).toEqual(["app.analytics", "checkout_started"]);
  });

  /**
   * `not.toHaveProperty` rather than `toBeUndefined`: both are `optionalKey` on
   * the wire, and a key present with an undefined value encodes as null — a
   * record claiming a channel whose name is nothing. Absence is the answer a
   * reader filtering on either field can act on.
   */
  test("an event that is about no signal carries neither field", () => {
    const encoded = encodeRecord(recordWith({ id: 1 }), "shape");

    expect(encoded).not.toHaveProperty("channel");
    expect(encoded).not.toHaveProperty("name");
  });

  /** One event, encoded at `policy` and sent through the transport. */
  function routed(event: object, policy: EncodePolicy): Record<string, unknown> {
    const encoded = encodeRecord(recordOf(event), policy);
    const received = acrossTheWire(Ingest.payloadSchema, {
      attachmentId: "attachment-1",
      records: [{ ...encoded, category: "state", timeline: "state", reason: "refresh", workId: 1 }],
      droppedSince: 0,
    });

    return received.records[0] as unknown as Record<string, unknown>;
  }

  function throwing(): never {
    throw new Error("routing field read");
  }

  /**
   * The routing fields are read outside the field walk, so its guards never see
   * them. A read that throws, or a value that is not a string, costs that field:
   * the record still crosses, and the payload is still what `fields` says.
   */
  test("a routing field that cannot be read costs that field, not the record", () => {
    for (const policy of ["none", "shape", "full"] as const) {
      const noRecord = routed(
        {
          _tag: "RuntimeSignalPublished",
          get record() {
            return throwing();
          },
          at: 1000,
        },
        policy
      );

      expect(noRecord["tag"]).toBe("RuntimeSignalPublished");
      expect(noRecord).not.toHaveProperty("channel");
      expect(noRecord).not.toHaveProperty("name");

      const noSignal = routed(
        {
          _tag: "RuntimeSignalSubscriberFailureObserved",
          subscriber: "audit-log",
          signal: {
            get signal() {
              return throwing();
            },
          },
          at: 1000,
        },
        policy
      );

      expect(noSignal).not.toHaveProperty("channel");
      expect(noSignal).not.toHaveProperty("name");

      const noChannel = routed(
        {
          _tag: "RuntimeSignalPublished",
          record: {
            signal: {
              get channel() {
                return throwing();
              },
              name: "checkout_started",
            },
          },
          at: 1000,
        },
        policy
      );

      expect(noChannel).not.toHaveProperty("channel");
      expect(noChannel["name"]).toBe("checkout_started");

      const numbered = routed(
        {
          _tag: "RuntimeSignalPublished",
          record: { signal: { channel: "app.analytics", name: 7 } },
          at: 1000,
        },
        policy
      );

      expect(numbered["channel"]).toBe("app.analytics");
      expect(numbered).not.toHaveProperty("name");
    }

    const unreadable = routed(
      {
        _tag: "RuntimeSignalPublished",
        get record() {
          return throwing();
        },
        at: 1000,
      },
      "shape"
    );

    expect((unreadable["fields"] as Record<string, unknown>)["record"]).toEqual({
      _: "opaque",
      type: "unreadable",
    });
  });
});

/**
 * These are read by an agent, one line per field, so the assertions are on the
 * exact rendering rather than on "some descriptor". The vocabulary is the
 * contract: a reader that has never seen this format has to be able to tell an
 * object from an array from a class instance without a legend, and any of these
 * strings silently changing shape is that contract breaking.
 */
describe("the shape vocabulary", () => {
  test("a plain object is its key list", () => {
    expect(fieldOf({ id: 1, name: "ada", total: 3 }, "shape")).toBe("{id,name,total}");
    expect(fieldOf({}, "shape")).toBe("{}");
  });

  /**
   * The discriminant is structure rather than data, and a field that reads
   * `Wired{_tag,run}` instead of `{_tag,run}` is the difference between knowing
   * which arm a node is in and knowing that it has arms.
   */
  test("a tagged object leads with its tag", () => {
    expect(fieldOf({ _tag: "Wired", run: { _tag: "Idle" } }, "shape")).toBe("Wired{_tag,run}");
  });

  test("a wide object says that it was cut", () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
    const encoded = fieldOf(wide, "shape") as string;

    expect(encoded.endsWith(",…}")).toBe(true);
    // Thirty-two keys and the marker.
    expect(encoded.slice(1, -1).split(",")).toHaveLength(33);
  });

  test("an array is named by its first element and its length", () => {
    expect(fieldOf(["a", "b"], "shape")).toBe("string[2]");
    expect(fieldOf([1, 2, 3], "shape")).toBe("number[3]");
    expect(fieldOf([{ id: 1, name: "ada" }], "shape")).toBe("{id,name}[1]");
  });

  /** Nothing to name it by, and `[]` alone would not say it was an array. */
  test("an empty array still says it is one", () => {
    expect(fieldOf([], "shape")).toBe("unknown[0]");
  });

  test("collections cross as their size", () => {
    expect(fieldOf(new Map([["a", 1]]), "shape")).toBe("Map(1)");
    expect(fieldOf(new Set([1, 2, 3]), "shape")).toBe("Set(3)");
  });

  /**
   * `{?}` rather than a bare type name: a class instance has fields this policy
   * will not name, and `AccountModel` on its own reads as one that has none.
   */
  test("a class instance is its type and an admission", () => {
    class AccountModel {
      readonly balance = 100;
    }

    expect(fieldOf(new AccountModel(), "shape")).toBe("AccountModel{?}");
  });

  test("values with no JSON form say what they were", () => {
    expect(fieldOf(() => undefined, "shape")).toBe("function");
    expect(fieldOf(Symbol("s"), "shape")).toBe("symbol");
    expect(fieldOf(10n, "shape")).toBe("bigint");
  });

  test("the depth bound is a value that says it stopped", () => {
    expect(fieldOf([[[[1]]]], "shape")).toBe("[…][1][1][1]");
  });
});

/**
 * The arm that did not exist: `"none"` fell through to the shape encoder, so an
 * app that had said it would disclose nothing answered a graph read with a key
 * list for every node on it.
 */
describe("the none policy", () => {
  test("none describes nothing about a value, not even its shape", () => {
    const encoder = createValueEncoder("none");

    expect(encoder.value({ token: "secret", nested: { id: 1 } })).toBe("withheld");
    expect(encoder.value(["a", "b"])).toBe("withheld");
    expect(encoder.value("ada")).toBe("withheld");
    expect(encoder.value(42)).toBe("withheld");
  });

  /**
   * The line `"none"` does not cross: that something failed, and which thing, is
   * not the value's data. What stays withheld is the failure's own payload and
   * its stack, which are.
   */
  test("none still says a failure happened, and names it", () => {
    const encoded = createValueEncoder("none").failure(wrapped()) as Record<string, unknown>;
    const frames = encoded["causes"] as ReadonlyArray<Record<string, unknown>>;

    expect(encoded["_"]).toBe("error");
    expect(encoded["message"]).toBe("upstream unavailable (503)");
    expect(frames[0]?.["tag"]).toBe("RefreshFailed");

    for (const frame of frames) {
      expect(frame).not.toHaveProperty("stack");
      expect(frame).not.toHaveProperty("fields");
    }
  });

  /**
   * `path` is the frame field that is app data wearing a runtime name — it is a
   * list of the app's own key names, which is a shape description by any
   * definition, under the one policy that promises no shape crosses. `valueKind`
   * is the smaller version of the same thing.
   */
  test("none withholds the key names a failure walked through", () => {
    const failure = Object.assign(new Error("validation failed"), {
      _tag: "Denied",
      path: ["order", "items", 0, "sku"],
      valueKind: "object",
    });

    const none = createValueEncoder("none").failure(failure) as Record<string, unknown>;
    const shape = createValueEncoder("shape").failure(failure) as Record<string, unknown>;
    const frameOf = (encoded: Record<string, unknown>) =>
      (encoded["causes"] as ReadonlyArray<Record<string, unknown>>)[0];

    expect(frameOf(none)).not.toHaveProperty("path");
    expect(frameOf(none)).not.toHaveProperty("valueKind");
    // Still named, still tagged: what `"none"` withholds is the app's data, not
    // the fact that something failed.
    expect(frameOf(none)?.["tag"]).toBe("Denied");

    // And `"shape"` is where a path is exactly what a reader wants.
    expect(frameOf(shape)?.["path"]).toEqual(["order", "items", "0", "sku"]);
  });
});

/**
 * Reading a value runs the app's code, so reading it can throw. None of these is
 * exotic: a computed getter that raises, a finalized immer draft, a torn-down
 * reactive scope. The encoder runs inside the app's own observer, where a throw
 * makes the record disappear without incrementing `dropped` — so "opaque" is the
 * only answer that keeps the feed honest.
 */
describe("values that fight back", () => {
  const cases: ReadonlyArray<readonly [string, () => object]> = [
    [
      "a getter that throws",
      () => ({
        get computed(): never {
          throw new Error("nope");
        },
      }),
    ],
    [
      "a revoked proxy",
      () => {
        const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
        revoke();
        return { held: proxy };
      },
    ],
    [
      "a prototype whose constructor throws",
      () =>
        Object.create(
          Object.create(Object.prototype, {
            constructor: {
              get(): never {
                throw new Error("nope");
              },
            },
          })
        ) as object,
    ],
  ];

  for (const [what, build] of cases) {
    test(`${what} is opaque rather than fatal, at every policy`, () => {
      for (const policy of ["none", "shape", "full"] as const) {
        const encoder = createValueEncoder(policy);

        expect(() => JSON.stringify(encoder.value(build()))).not.toThrow();
      }
    });
  }

  test("only the unreadable part goes opaque; its siblings survive", () => {
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();

    const encoded = createValueEncoder("full").value({
      before: "kept",
      bad: proxy,
      after: "also kept",
    }) as Record<string, unknown>;

    expect(encoded["before"]).toBe("kept");
    expect(encoded["after"]).toBe("also kept");
    expect(encoded["bad"]).toEqual({ _: "opaque", type: "unreadable" });
  });

  /**
   * The throw comes from reading the field, not from walking what it held, so
   * it happens in the object's own walk. Guarding only the walk below a field
   * would still trade the whole object for one getter.
   */
  test("a getter that throws costs its own field, not the object", () => {
    const encoded = createValueEncoder("full").value({
      id: "order-42",
      get total(): never {
        throw new Error("x");
      },
      status: "open",
    });

    expect(encoded).toEqual({
      id: "order-42",
      total: { _: "opaque", type: "unreadable" },
      status: "open",
    });
  });

  /** A proxy over `target` whose read of `throwing` throws. */
  function throwingOn<T extends object>(target: T, throwing: string): T {
    return new Proxy(target, {
      get: (inner, key) => {
        if (key === throwing) {
          throw new Error("x");
        }

        return Reflect.get(inner, key) as unknown;
      },
    });
  }

  test("an array entry that throws costs that entry, not the array", () => {
    expect(createValueEncoder("full").value(throwingOn(["a", "b", "c"], "1"))).toEqual([
      "a",
      { _: "opaque", type: "unreadable" },
      "c",
    ]);
  });

  test("an array whose length read throws keeps its entries", () => {
    expect(createValueEncoder("full").value(throwingOn(["a", "b"], "length"))).toEqual(["a", "b"]);
  });

  /**
   * Without `length`, the array's extent comes from its own keys: every index
   * key, enumerable or not, and nothing past the largest array index, which is
   * `2 ** 32 - 2`. `"4294967295"` is an ordinary key on an array.
   */
  test("an array whose length read throws is as long as its index keys say", () => {
    const hidden = ["a"];
    Object.defineProperty(hidden, "2", { value: "c", enumerable: false });

    const named = Object.assign(["a"], { "4294967295": "x" });

    expect(crossed(throwingOn(hidden, "length"), "full")).toEqual(["a", null, "c"]);
    expect(crossed(throwingOn(named, "length"), "full")).toEqual(["a"]);
  });

  test("a collection whose size read throws keeps its entries", () => {
    class SizelessMap extends Map<string, number> {
      override get size(): number {
        throw new Error("x");
      }
    }

    class SizelessSet extends Set<string> {
      override get size(): number {
        throw new Error("x");
      }
    }

    const encoder = createValueEncoder("full");

    expect(encoder.value(new SizelessMap([["a", 1]]))).toEqual({
      _: "map",
      entries: [["a", 1]],
      size: 1,
    });
    expect(encoder.value(new SizelessSet(["a", "b"]))).toEqual({
      _: "set",
      values: ["a", "b"],
      size: 2,
    });
  });

  test("a collection whose iteration throws partway keeps what it read", () => {
    class BrokenMap extends Map<string, number> {
      override *entries(): MapIterator<[string, number]> {
        yield ["a", 1];
        throw new Error("x");
      }
    }

    class BrokenSet extends Set<string> {
      override *values(): SetIterator<string> {
        yield "a";
        throw new Error("x");
      }
    }

    const encoder = createValueEncoder("full");

    expect(
      encoder.value(
        new BrokenMap([
          ["a", 1],
          ["b", 2],
        ])
      )
    ).toEqual({
      _: "map",
      entries: [
        ["a", 1],
        [
          { _: "opaque", type: "unreadable" },
          { _: "opaque", type: "unreadable" },
        ],
      ],
      size: 2,
    });
    expect(encoder.value(new BrokenSet(["a", "b"]))).toEqual({
      _: "set",
      values: ["a", { _: "opaque", type: "unreadable" }],
      size: 2,
    });
  });

  /**
   * A map and a set whose iterators hand out `steps` as they are, then end.
   * Each step is the app's own object, so reading it runs the app's code.
   */
  function iteratingWith(steps: ReadonlyArray<unknown>): {
    readonly map: Map<unknown, unknown>;
    readonly set: Set<unknown>;
  } {
    function scripted(): object {
      let index = 0;

      return {
        next: () => (index < steps.length ? steps[index++] : { done: true, value: undefined }),
        [Symbol.iterator]() {
          return this;
        },
      };
    }

    class ScriptedMap extends Map<unknown, unknown> {
      override entries(): MapIterator<[unknown, unknown]> {
        return scripted() as MapIterator<[unknown, unknown]>;
      }
    }

    class ScriptedSet extends Set<unknown> {
      override values(): SetIterator<unknown> {
        return scripted() as SetIterator<unknown>;
      }
    }

    return { map: new ScriptedMap(), set: new ScriptedSet() };
  }

  function entriesOf(value: unknown): unknown {
    return (createValueEncoder("full").value(value) as { readonly entries: unknown }).entries;
  }

  function valuesOf(value: unknown): unknown {
    return (createValueEncoder("full").value(value) as { readonly values: unknown }).values;
  }

  const unreadable = { _: "opaque", type: "unreadable" };

  /** A map entry's key and value come from one read of the step's `value`. */
  test("a collection step's value is read once", () => {
    let reads = 0;
    const { map } = iteratingWith([
      {
        done: false,
        get value(): [number, number] {
          reads++;
          return [reads, reads];
        },
      },
    ]);

    expect(entriesOf(map)).toEqual([[1, 1]]);
  });

  /** The iterator protocol ends on any truthy `done`, as a spread does. */
  test("a collection step whose done is truthy but not true ends the walk", () => {
    expect(entriesOf(iteratingWith([{ done: 1, value: ["phantom", 1] }]).map)).toEqual([]);
    expect(valuesOf(iteratingWith([{ done: "yes", value: "phantom" }]).set)).toEqual([]);
  });

  /**
   * `entries()` and `values()` are read as a spread reads them: through the
   * iterable they return, which need not be an iterator itself.
   */
  test("a collection whose entries or values is an iterable rather than an iterator", () => {
    class ListedMap extends Map<string, number> {
      override entries(): MapIterator<[string, number]> {
        return [["good", 1]] as unknown as MapIterator<[string, number]>;
      }
    }

    class ListedSet extends Set<string> {
      override values(): SetIterator<string> {
        return ["good"] as unknown as SetIterator<string>;
      }
    }

    expect(entriesOf(new ListedMap())).toEqual([["good", 1]]);
    expect(valuesOf(new ListedSet())).toEqual(["good"]);
  });

  /**
   * A step whose `value` cannot be read is still a step: the iterator said it
   * was not done, so the walk goes on past it.
   */
  test("a collection step whose value or pair half throws costs that step", () => {
    const throwing = {
      done: false,
      get value(): never {
        throw new Error("x");
      },
    };
    const halfReadable = {
      done: false,
      value: {
        get 0(): never {
          throw new Error("x");
        },
        1: 2,
      },
    };
    const { map } = iteratingWith([
      { done: false, value: ["a", 1] },
      throwing,
      halfReadable,
      { done: false, value: ["d", 4] },
    ]);
    const { set } = iteratingWith([
      { done: false, value: "a" },
      throwing,
      { done: false, value: "c" },
    ]);

    expect(entriesOf(map)).toEqual([
      ["a", 1],
      [unreadable, unreadable],
      [unreadable, 2],
      ["d", 4],
    ]);
    expect(valuesOf(set)).toEqual(["a", unreadable, "c"]);
  });

  /**
   * Without a readable `done` there is no telling whether the walk is over, so
   * it stops there, as it does when `next` throws, and keeps what it read.
   */
  test("a collection step whose done throws, or that is not an object, ends the walk", () => {
    const throwing = {
      get done(): never {
        throw new Error("x");
      },
      value: "b",
    };

    for (const broken of [throwing, 7]) {
      const { map, set } = iteratingWith([
        { done: false, value: ["a", 1] },
        broken,
        { done: false, value: ["c", 3] },
      ]);

      expect(entriesOf(map)).toEqual([
        ["a", 1],
        [unreadable, unreadable],
      ]);
      expect(valuesOf(set)).toEqual([["a", 1], unreadable]);
    }
  });

  /**
   * An event field is read before any value walk starts, so the walk's own
   * guards never see the throw.
   */
  test("an event getter that throws costs its own field, not the record", () => {
    const event = {
      _tag: "Probe",
      kept: 1,
      get broken(): never {
        throw new Error("x");
      },
    };

    for (const policy of ["shape", "full"] as const) {
      expect(encodeRecord(recordOf(event), policy).fields).toEqual({
        kept: 1,
        broken: { _: "opaque", type: "unreadable" },
      });
    }
  });

  /**
   * A function's name is read off the function, which can make the read throw
   * or answer with something a template string cannot hold, like a symbol.
   */
  test("a function whose name read throws or is not a string costs only its name", () => {
    const throwing = Object.defineProperty(function handler() {}, "name", {
      get(): never {
        throw new Error("x");
      },
    });
    const symbolic = Object.defineProperty(function handler() {}, "name", {
      value: Symbol("name"),
    });
    const anonymous = { _: "opaque", type: "function:anonymous" };

    for (const handler of [throwing, symbolic]) {
      expect(createValueEncoder("full").value([1, handler, 3])).toEqual([1, anonymous, 3]);
      expect(
        createValueEncoder("full").value(
          new Map<string, unknown>([
            ["a", handler],
            ["b", 2],
          ])
        )
      ).toEqual({
        _: "map",
        entries: [
          ["a", anonymous],
          ["b", 2],
        ],
        size: 2,
      });
      expect(encodeRecord(recordOf({ _tag: "Probe", handler, kept: 1 }), "full").fields).toEqual({
        handler: anonymous,
        kept: 1,
      });
    }
  });

  /** A class instance with readable fields whose `constructor` read throws. */
  function orderWithThrowingConstructor(): object {
    const prototype = Object.create(Object.prototype, {
      constructor: {
        get(): never {
          throw new Error("x");
        },
      },
    }) as object;

    return Object.assign(Object.create(prototype) as object, {
      id: "order-42",
      status: "open",
    });
  }

  /**
   * The type name is read after the fields, from the prototype, so a throw
   * there is the same kind of loss as a throwing getter: one label, not the
   * fields already read.
   */
  test("a constructor that throws costs the type name, not the fields", () => {
    expect(createValueEncoder("full").value(orderWithThrowingConstructor())).toEqual({
      id: "order-42",
      status: "open",
      _type: "object",
    });
  });

  /** At `"shape"` the type name is the whole label, so only the name falls back. */
  test("a constructor that throws costs the type name, not the label, at shape", () => {
    expect(createValueEncoder("shape").value(orderWithThrowingConstructor())).toBe("object{?}");
  });

  /**
   * At `"shape"` an array is its first element's name and its length, read
   * apart: an unreadable first element is named so, and an unreadable length
   * is `?`, and neither costs the other.
   */
  test("an array's first element and length are read apart, at shape", () => {
    const encoder = createValueEncoder("shape");

    expect(encoder.value(throwingOn(["a", "b"], "0"))).toBe("unreadable[2]");
    expect(encoder.value(throwingOn(["a", "b"], "length"))).toBe("string[?]");
  });

  /** An unreadable value is not a failure, so it is not named as one. */
  test("an array of an unreadable value is named for it, at shape", () => {
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();

    expect(createValueEncoder("shape").value([proxy])).toBe("unreadable[1]");
    expect(createValueEncoder("shape").value([new Error("x")])).toBe("error[1]");
  });

  /** The tag is one more read; a throw there costs the tag, not the key list. */
  test("a tag that throws costs the tag, not the keys, at shape", () => {
    const tagged = {
      id: 1,
      get _tag(): never {
        throw new Error("x");
      },
    };

    expect(createValueEncoder("shape").value(tagged)).toBe("{id,_tag}");
  });
});

/**
 * Builds an error with a stack that is a fixture rather than wherever this test
 * happens to run from. The frame selection is the thing under test, and a real
 * stack here would change with the runner.
 */
function stacked(frames: ReadonlyArray<string>): Error {
  const error = new Error("boom");

  error.stack = ["Error: boom", ...frames].join("\n");

  return error;
}

function stackOf(error: Error): string {
  const frames = (fieldOf(error, "full") as Record<string, unknown>)["causes"] as ReadonlyArray<
    Record<string, unknown>
  >;

  return frames[0]?.["stack"] as string;
}

describe("stack abridging", () => {
  /**
   * The failure a character bound produces: the app frames sit below a wall of
   * Effect and runtime internals, so the first 2048 characters are reliably the
   * part nobody needed.
   */
  test("library frames go, app frames stay, and the header survives", () => {
    const stack = stackOf(
      stacked([
        "    at load (/app/src/orders.ts:12:5)",
        "    at Object.run (/app/node_modules/effect/dist/index.js:44:9)",
        "    at drain (node:internal/process/task_queues:95:5)",
        "    at commit (/app/src/graph.ts:88:3)",
      ])
    );

    expect(stack.split("\n")[0]).toBe("Error: boom");
    expect(stack).toContain("orders.ts:12:5");
    expect(stack).toContain("graph.ts:88:3");
    expect(stack).not.toContain("node_modules");
    expect(stack).not.toContain("node:internal");
  });

  /**
   * An abridged trace that does not admit it is abridged reads as the whole
   * story, and a reader who cannot find the caller in it blames the code.
   */
  test("the trace says how many frames it dropped", () => {
    const stack = stackOf(
      stacked([
        "    at load (/app/src/orders.ts:12:5)",
        "    at Object.run (/app/node_modules/effect/dist/index.js:44:9)",
        "    at drain (node:internal/process/task_queues:95:5)",
      ])
    );

    expect(stack).toContain("2 frames dropped");
  });

  test("a long app trace keeps the first fifteen frames", () => {
    const stack = stackOf(
      stacked(
        Array.from({ length: 30 }, (_, index) => `    at step${index} (/app/src/run.ts:${index}:1)`)
      )
    );

    expect(stack).toContain("at step0 ");
    expect(stack).toContain("at step14 ");
    expect(stack).not.toContain("at step15 ");
    expect(stack).toContain("15 frames dropped");
  });

  /**
   * A failure raised entirely inside a dependency still says where in that
   * dependency, and an empty stack would trade a bad trace for no trace.
   */
  test("a trace that is library all the way down keeps its top two frames", () => {
    const stack = stackOf(
      stacked(
        Array.from(
          { length: 6 },
          (_, index) => `    at run (/app/node_modules/effect/dist/index.js:${index}:1)`
        )
      )
    );

    expect(stack.split("\n").filter((line) => line.includes("node_modules"))).toHaveLength(2);
    expect(stack).toContain("4 frames dropped");
  });

  /**
   * The header is "everything above the first frame", and a message can look
   * like a frame. A module-resolution error is the ordinary case: its message
   * carries a `node_modules` path ending in `:line:col`, which is how a JSC
   * frame ends. Read as a frame, it left the header empty and then handed the
   * message itself to the library filter, which dropped it.
   */
  test("a message that ends like a frame is still a header", () => {
    const error = new Error("boom");

    error.stack = [
      "Error: Cannot find module /app/node_modules/@scope/pkg/index.js:1:1",
      "    at load (/app/src/boot.ts:4:2)",
      "    at run (/app/node_modules/effect/dist/x.js:1:1)",
    ].join("\n");

    const stack = stackOf(error);

    expect(stack).toContain("Cannot find module");
    expect(stack).toContain("at load (/app/src/boot.ts:4:2)");
    expect(stack).toContain("1 frame dropped");
  });

  /**
   * Bun writes its own native frames as `native:1:11`, which neither
   * parenthesized spelling matches. Left unrecognized they read as app frames
   * and spend the 15-frame allowance on the module loader.
   */
  test("bun's native frames count as library frames", () => {
    const stack = stackOf(
      stacked([
        "    at open (/app/src/db.ts:8:3)",
        "    at moduleEvaluation (native:1:11)",
        "    at asyncModuleEvaluation (native:2)",
      ])
    );

    expect(stack).toContain("at open (/app/src/db.ts:8:3)");
    expect(stack).not.toContain("native:");
    expect(stack).toContain("2 frames dropped");
  });

  /**
   * JSC writes frames this cannot parse — `promiseReactionJob@[native code]`
   * has no `:line:col`. Leaving them out of the count would let the trace claim
   * it accounted for what it removed while quietly removing more.
   */
  test("lines it cannot parse are still counted as dropped", () => {
    const stack = stackOf(
      stacked(["    at open (/app/src/db.ts:8:3)", "promiseReactionJob@[native code]"])
    );

    expect(stack).toContain("1 frame dropped");
  });

  /** Not a stack this can reason about, so it does not pretend to. */
  test("an unrecognizable stack falls back to the character bound", () => {
    const error = new Error("boom");
    error.stack = "x".repeat(5000);

    const stack = stackOf(error);

    expect(stack).toHaveLength(2049);
    expect(stack.endsWith("…")).toBe(true);
  });
});

/**
 * The failure Frond actually produces. `Data.TaggedError` extends `Error` with
 * an empty `message`, so an encoder that stops at the outermost link reports
 * `{name, message: ""}` — the exact shape this suite exists to prevent.
 */
class RefreshFailed extends Data.TaggedError("RefreshFailed")<{
  readonly nodeId: string;
  readonly tag: string;
  readonly cause: unknown;
}> {}

/** A domain error, with the payload that makes it worth reading. */
class UpstreamError extends Error {
  readonly status = 503;
  readonly endpoint = "/v1/session";
}

function wrapped(): RefreshFailed {
  return new RefreshFailed({
    nodeId: "session",
    tag: "resource",
    cause: new UpstreamError("upstream unavailable (503)"),
  });
}

describe("failure encoding", () => {
  /**
   * The whole point. A feed that says `RefreshFailed` and nothing else has told
   * an agent that something failed and withheld what — which is worse than
   * silence, because it reads as an answer.
   */
  test("shape reaches past the wrapper to the message that says what happened", () => {
    const encoded = fieldOf(wrapped(), "shape") as Record<string, unknown>;
    const frames = encoded["causes"] as ReadonlyArray<Record<string, unknown>>;

    expect(encoded["_"]).toBe("error");
    expect(encoded["message"]).toBe("upstream unavailable (503)");
    expect(frames).toHaveLength(2);
    expect(frames[0]?.["tag"]).toBe("RefreshFailed");
    expect(frames[0]?.["nodeId"]).toBe("session");
    expect(frames[0]?.["nodeTag"]).toBe("resource");
    expect(frames[1]?.["message"]).toBe("upstream unavailable (503)");
  });

  /** The payload's own walk guards each field; copying it out has to as well. */
  test("full keeps a failure's readable payload when one of its getters throws", () => {
    const failure = Object.defineProperties(new Error("boom"), {
      status: { value: 503, enumerable: true },
      endpoint: {
        enumerable: true,
        get(): never {
          throw new Error("x");
        },
      },
    });
    const encoded = encodeRecord(recordOf({ _tag: "Probe" }, [failure]), "full");
    const { causes } = encoded.failures[0] as {
      readonly causes: ReadonlyArray<Record<string, unknown>>;
    };

    expect(causes[0]?.["fields"]).toEqual({
      status: 503,
      endpoint: { _: "opaque", type: "unreadable" },
    });
  });

  /**
   * `shape`'s contract is structure without contents, and an error's own
   * payload is contents. The stack goes with it for a different reason: at this
   * policy it is bulk, not signal.
   */
  test("shape withholds stacks and the error's own payload", () => {
    const frames = (fieldOf(wrapped(), "shape") as Record<string, unknown>)[
      "causes"
    ] as ReadonlyArray<Record<string, unknown>>;

    for (const frame of frames) {
      expect(frame).not.toHaveProperty("stack");
      expect(frame).not.toHaveProperty("fields");
    }
    // `503` is in the message, which does cross at this policy. The payload the
    // error carried separately is what must not.
    expect(JSON.stringify(frames)).not.toContain("/v1/session");
  });

  /**
   * The other half of a useful failure: the chain says which node and which
   * operation, the payload says which endpoint and which status.
   */
  test("full adds stacks and the error's own payload", () => {
    const frames = (fieldOf(wrapped(), "full") as Record<string, unknown>)[
      "causes"
    ] as ReadonlyArray<Record<string, unknown>>;

    expect(frames.every((frame) => typeof frame["stack"] === "string")).toBe(true);
    expect(frames[1]?.["fields"]).toEqual({ status: 503, endpoint: "/v1/session" });
    // The wrapper carries nothing the chain has not already named, so it says
    // nothing twice.
    expect(frames[0]).not.toHaveProperty("fields");
  });

  /**
   * Core builds a preview for a human reading an error report; for an `Error` it
   * is name, message, stack and cause, every one of which the frame already has
   * — and the cause recursively, so one per link would send the chain n times.
   */
  test("no frame carries a preview", () => {
    for (const policy of ["shape", "full"] as const) {
      const frames = (fieldOf(wrapped(), policy) as Record<string, unknown>)[
        "causes"
      ] as ReadonlyArray<Record<string, unknown>>;

      expect(frames.some((frame) => "preview" in frame)).toBe(false);
    }
  });

  /**
   * The payload walk reaches back into the chain here. Without the links on the
   * ancestor path it would re-enter this encoder on a value it is already
   * inside, and not come back.
   */
  test("full marks a payload that points back at the failure", () => {
    const failure: Record<string, unknown> = { _tag: "Loop", message: "round we go" };
    failure["self"] = failure;

    const encoded = encodeRecord(recordWith(undefined, [failure]), "full").failures[0] as Record<
      string,
      unknown
    >;
    const frames = encoded["causes"] as ReadonlyArray<Record<string, unknown>>;

    expect(frames[0]?.["fields"]).toEqual({ self: { _: "cycle" } });
  });

  /**
   * The other direction, and the harder one: an app object that holds an error
   * whose `cause` points back at that object. Frond wraps failures with `cause`
   * pointing at app values, and app values with parent pointers — a store root,
   * an ORM relation — are the common case rather than the exotic one.
   *
   * The failure this guards is subtle. Describing the error puts its whole chain
   * on the ancestor path, and clearing that path on the way out used to clear the
   * *enclosing* walk's marks too. The object was then no longer an ancestor as
   * far as the walk was concerned, so every later reference to it re-expanded
   * instead of being named — turning a ~150-byte answer into megabytes stopped
   * only by the node budget, computed synchronously on the app's own fiber.
   */
  test("full still names a cycle through a value the failure points back at", () => {
    const root: Record<string, unknown> = { name: "root" };
    const failure = new Error("boom");

    failure.cause = root;
    root["failure"] = failure;
    root["againA"] = root;
    root["againB"] = root;

    const encoded = createValueEncoder("full").value(root) as Record<string, unknown>;

    expect(encoded["againA"]).toEqual({ _: "cycle" });
    expect(encoded["againB"]).toEqual({ _: "cycle" });
    // And the whole thing stays small, which is the property that actually
    // matters to an app being observed.
    expect(JSON.stringify(encoded).length).toBeLessThan(2_000);
  });

  /**
   * `failures` is the runtime's own list of what went wrong, so it is encoded as
   * such rather than sniffed. That is what makes it work for the failures that
   * are not `Error` instances — an Effect `Cause`, or a plain tagged object —
   * which the value encoder would otherwise reduce to a list of key names.
   */
  /**
   * The runtime lifts `failures` straight off the event's own fields, so the
   * same object shows up in both places. Describing it one way in `fields` and
   * another in `failures` would read as two different things having gone wrong.
   */
  test("a failure reads the same in fields as in failures", () => {
    const failure = { _tag: "SinkFailure", cause: { _tag: "Died", message: "sink threw" } };
    const encoded = encodeRecord(recordWith(failure, [failure]), "shape");

    expect(encoded.fields["value"]).toEqual(encoded.failures[0] as never);
  });

  /**
   * A refresh against a node that is not ready fails with the node's *status*
   * as its cause, which is a legitimate failure with no message anywhere in it.
   * Core renders that as the value's kind, and `"object"` sitting in a field
   * called `message` reads as a message.
   */
  test("a chain with nothing to say names the failure instead of describing a value", () => {
    const failure = { _tag: "RefreshFailed", cause: { _tag: "Wired", run: { _tag: "Idle" } } };
    const encoded = encodeRecord(recordWith(undefined, [failure]), "shape").failures[0] as Record<
      string,
      unknown
    >;

    expect(encoded["message"]).toBe("RefreshFailed");
  });

  test("failures carry their chain even when they are not Errors", () => {
    const failure = { _tag: "SinkFailure", cause: { _tag: "Died", message: "sink threw" } };
    const encoded = encodeRecord(recordWith(undefined, [failure]), "shape").failures[0] as Record<
      string,
      unknown
    >;

    expect(encoded["_"]).toBe("error");
    expect(encoded["message"]).toBe("sink threw");
    expect((encoded["causes"] as ReadonlyArray<Record<string, unknown>>)[0]?.["tag"]).toBe(
      "SinkFailure"
    );
  });

  /**
   * `"none"` is a statement about values, not about what broke. An app that has
   * turned disclosure off entirely still wants to know its refreshes are
   * failing, and the failure list is the one place that survives.
   */
  test("none still reports failures", () => {
    const encoded = encodeRecord(recordWith({ secret: 1 }, [wrapped()]), "none");

    expect(encoded.fields).toEqual({});
    expect((encoded.failures[0] as Record<string, unknown>)["message"]).toBe(
      "upstream unavailable (503)"
    );
  });

  /**
   * The failure list is encoded the way `Array.map` would: a hole stays a hole,
   * and goes over JSON as `null`, rather than becoming a described `undefined`.
   */
  test.each([
    "none",
    "shape",
    "full",
  ] as const)("a hole in failures stays a hole at %s", (policy) => {
    const failures: Array<unknown> = [];
    failures[1] = new Error("second");
    const encoded = encodeRecord(recordWith(undefined, failures), policy);

    expect(encoded.failures).toHaveLength(2);
    expect(0 in encoded.failures).toBe(false);
    expect(JSON.stringify(encoded.failures).startsWith("[null,")).toBe(true);
  });

  /**
   * The length is read once, as `Array.map` reads it: a failure whose getter
   * appends another while it is encoded yields one encoded failure, not two.
   */
  test.each([
    "none",
    "shape",
    "full",
  ] as const)("a failure appended while encoding is not encoded at %s", (policy) => {
    const failures: Array<unknown> = [];
    const failure = new Error("first");
    let appended = false;
    Object.defineProperty(failure, "message", {
      get: () => {
        if (!appended) {
          appended = true;
          failures.push(new Error("late"));
        }
        return "first";
      },
    });
    failures.push(failure);
    const encoded = encodeRecord(recordWith(undefined, failures), policy);

    expect(appended).toBe(true);
    expect(encoded.failures).toHaveLength(1);
  });
});

/**
 * A number with no JSON form fails the transport, not just the reader.
 *
 * The NDJSON codec validates every `Unknown` hole as a JSON value and rejects
 * `NaN` and both infinities outright, so one such field used to fail the whole
 * `Frond.Ingest` batch — every record in it, not only the one that held it.
 * Through the real codec on purpose: `JSON.stringify` alone would turn each of
 * them into `null` and pass, hiding both the failure and the collision with a
 * field that really was `null`.
 *
 * The values are the event's own fields so that both policies encode each one
 * as a value. At `"shape"` a nested object is a key list, and no number inside
 * it would reach the wire to be tested.
 */
describe("numbers with no JSON form", () => {
  const event = {
    _tag: "Probe",
    rate: Number.NaN,
    upper: Number.POSITIVE_INFINITY,
    lower: Number.NEGATIVE_INFINITY,
    empty: null,
    finite: 42,
  };

  for (const policy of ["shape", "full"] as const) {
    test(`an event field crosses the transport distinguishable, at ${policy}`, () => {
      const encoded = encodeRecord(recordOf(event), policy);
      // `recordOf` fills the routing fields with placeholders the encoder does
      // not read; the wire schema does, so they are swapped for real members.
      const record = {
        ...encoded,
        category: "state",
        timeline: "state",
        reason: "refresh",
        workId: 1,
      } as const;

      const received = acrossTheWire(Ingest.payloadSchema, {
        attachmentId: "attachment-1",
        records: [record],
        droppedSince: 0,
      });

      expect(received.records[0]?.fields).toEqual({
        rate: { _: "opaque", type: "number:NaN" },
        upper: { _: "opaque", type: "number:Infinity" },
        lower: { _: "opaque", type: "number:-Infinity" },
        empty: null,
        finite: 42,
      });
    });
  }

  /**
   * A type name is read off the app's own prototype, and nothing makes it a
   * string: a `name` the app set to a number is a number.
   */
  test("a type name that is not a string falls back to the generic one", () => {
    const prototype = { constructor: { name: Number.POSITIVE_INFINITY } };
    const order = Object.assign(Object.create(prototype) as object, { id: "order-42" });

    expect(crossed(order, "full")).toEqual({ id: "order-42", _type: "object" });
    expect(crossed(order, "shape")).toBe("object{?}");
  });

  /**
   * A collection's size is read through its own getter, which a subclass can
   * override to say anything. The entries are what was really there.
   */
  test("a collection whose size has no JSON form is sized by its entries", () => {
    class EndlessMap extends Map<string, number> {
      override get size(): number {
        return Number.POSITIVE_INFINITY;
      }
    }

    class EndlessSet extends Set<string> {
      override get size(): number {
        return Number.NaN;
      }
    }

    expect(crossed(new EndlessMap([["a", 1]]), "full")).toEqual({
      _: "map",
      entries: [["a", 1]],
      size: 1,
    });
    expect(crossed(new EndlessSet(["a", "b"]), "full")).toEqual({
      _: "set",
      values: ["a", "b"],
      size: 2,
    });
  });

  /**
   * A date crosses as what its `toISOString` returns, and an override can
   * return anything. An invalid date already crosses as unreadable (the
   * built-in throws); an answer that is not a string crosses the same way.
   */
  test("a date whose toISOString is not a string crosses as unreadable", () => {
    const answers: ReadonlyArray<unknown> = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      10n,
      Symbol("iso"),
    ];

    for (const answer of answers) {
      const date = Object.assign(new Date(0), { toISOString: () => answer });

      expect(crossed(date, "full")).toEqual({ _: "opaque", type: "unreadable" });
    }

    expect(crossed(new Date(Number.NaN), "full")).toEqual({ _: "opaque", type: "unreadable" });
    expect(crossed(new Date(0), "full")).toBe("1970-01-01T00:00:00.000Z");
  });

  /**
   * Not a number, but the same failure: `map` skips a hole and leaves one in
   * its result, and the codec rejects a hole as it rejects `undefined`.
   */
  test("a sparse array crosses with its holes as null", () => {
    const sparse: Array<number> = [1];
    sparse[2] = 3;

    expect(crossed(sparse, "full")).toEqual([1, null, 3]);
  });

  /** A real array cannot do this; a proxy over one can. */
  test("an array whose length has no JSON form still says it was cut", () => {
    const endless = new Proxy(["a"], {
      get: (target, key) =>
        key === "length" ? Number.POSITIVE_INFINITY : Reflect.get(target, key),
    });

    expect((crossed(endless, "full") as ReadonlyArray<unknown>).at(-1)).toEqual({
      _: "elided",
      by: "entries",
    });
  });
});

/**
 * A key JSON carries as data but assignment does not.
 *
 * `JSON.parse` makes `__proto__` an own key like any other, so an app holding a
 * parsed payload holds one. Assigned with `out[key] =`, it sets the output's
 * prototype instead, and the codec then rejects the whole batch.
 */
describe("a key named __proto__", () => {
  const parsed = (): unknown => JSON.parse('{"__proto__":{"flag":1},"good":2}');

  function expectOwnPrototypeKey(received: unknown): void {
    expect(Object.getPrototypeOf(received)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(received, "__proto__")).toBe(true);
    expect(JSON.stringify(received)).toBe('{"__proto__":{"flag":1},"good":2}');
  }

  test("crosses the transport as an own key, at full", () => {
    expectOwnPrototypeKey(crossed(parsed(), "full"));
  });

  test("crosses the transport as an own key of a failure's payload, at full", () => {
    const failure = Object.assign(new Error("boom"), { response: parsed() });
    const encoded = encodeRecord(recordOf({ _tag: "Probe" }, [failure]), "full");
    const received = acrossTheWire(Ingest.payloadSchema, {
      attachmentId: "attachment-1",
      records: [{ ...encoded, category: "state", timeline: "state", reason: "refresh", workId: 1 }],
      droppedSince: 0,
    });
    const { causes } = received.records[0]?.failures[0] as {
      readonly causes: ReadonlyArray<{ readonly fields?: { readonly response?: unknown } }>;
    };

    expectOwnPrototypeKey(causes[0]?.fields?.response);
  });

  test("survives as an own key of the payload itself, at full", () => {
    // Defined rather than assigned, for the reason this block exists.
    const failure = Object.defineProperties(new Error("boom"), {
      ["__proto__"]: { value: { flag: 1 }, enumerable: true, writable: true, configurable: true },
      status: { value: 500, enumerable: true, writable: true, configurable: true },
    });
    const encoded = encodeRecord(recordOf({ _tag: "Probe" }, [failure]), "full");
    const { causes } = encoded.failures[0] as {
      readonly causes: ReadonlyArray<{ readonly fields?: unknown }>;
    };

    expect(JSON.stringify(causes[0]?.fields)).toBe('{"__proto__":{"flag":1},"status":500}');
  });
});

describe("aggregate failures", () => {
  /** What the runtime builds when two of a node's dependencies fail together. */
  function twoDependenciesFailed(cause: unknown): Graph.DependencyFailures {
    const failed = (dependency: string): Graph.DependencyFailed =>
      new Graph.DependencyFailed({
        nodeId: "orders:v1" as Graph.NodeId,
        tag: "orders",
        dependency,
        dependencyNodeId: `${dependency}:v1` as Graph.NodeId,
        cause,
      });

    return new Graph.DependencyFailures({
      nodeId: "orders:v1" as Graph.NodeId,
      tag: "orders",
      failures: [failed("rates"), failed("prices")],
    });
  }

  function ingested(failure: unknown, policy: EncodePolicy): unknown {
    const encoded = encodeRecord(recordOf({ _tag: "Probe" }, [failure]), policy);
    const received = acrossTheWire(Ingest.payloadSchema, {
      attachmentId: "attachment-1",
      records: [{ ...encoded, category: "state", timeline: "state", reason: "refresh", workId: 1 }],
      droppedSince: 0,
    });

    return received.records[0]?.failures[0];
  }

  function nestedFrames(descriptor: unknown): ReadonlyArray<Record<string, unknown>> {
    const { causes } = descriptor as {
      readonly causes: ReadonlyArray<{
        readonly failures?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
      }>;
    };

    return causes.flatMap((frame) => (frame.failures ?? []).flat());
  }

  for (const policy of ["none", "shape", "full"] as const) {
    for (const ratio of [1, Number.NaN]) {
      test(`two failed dependencies cross the transport with ratio ${ratio}, at ${policy}`, () => {
        const received = ingested(twoDependenciesFailed({ ratio }), policy);

        expect(nestedFrames(received).length).toBeGreaterThan(0);
      });
    }

    test(`a nested frame is reduced like the frame that holds it, at ${policy}`, () => {
      const frames = nestedFrames(
        encodeRecord(recordOf({ _tag: "Probe" }, [twoDependenciesFailed({ ratio: 1 })]), policy)
          .failures[0]
      );

      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        expect(frame).not.toHaveProperty("preview");
        expect(Object.values(frame)).not.toContain(undefined);

        if (policy !== "full") {
          expect(frame).not.toHaveProperty("stack");
        }

        if (policy === "none") {
          expect(frame).not.toHaveProperty("path");
          expect(frame).not.toHaveProperty("valueKind");
        }
      }
    });
  }

  /**
   * `cancellation` is the one frame field that is itself a record, and core
   * fills both of its keys whether the failure had them or not.
   */
  /**
   * Core builds the cancellation it hands over as plain data, so this is not
   * reachable through `describeError` today; it is tested directly so that
   * staying true does not depend on core.
   */
  test("a cancellation's fields are each read once", () => {
    let reads = 0;
    const cancellation = {
      get detail(): number {
        reads += 1;
        return reads;
      },
    };

    expect(compact(cancellation)).toEqual({ detail: 1 });
    expect(reads).toBe(1);
  });

  test("a cancellation without a detail crosses the transport", () => {
    const received = ingested({ message: "stopped", cancellation: { _tag: "Stopped" } }, "shape");

    expect(received).toMatchObject({ causes: [{ cancellation: { _tag: "Stopped" } }] });
  });
});

/**
 * A failure's `path` is core's list of the key names it walked, and core keeps
 * a hole in it where the failure's own list had one. The codec rejects a hole
 * as it rejects `undefined`, so one hole would fail the whole batch.
 */
describe("a failure path with holes", () => {
  for (const policy of ["shape", "full"] as const) {
    test(`crosses the transport with each hole as core writes undefined, at ${policy}`, () => {
      const sparse: Array<string> = ["a"];
      sparse[2] = "c";

      for (const [path, expected] of [
        [new Array(2), ["undefined", "undefined"]],
        [sparse, ["a", "undefined", "c"]],
      ] as const) {
        const failure = Object.assign(new Error("boom"), { path });
        const encoded = encodeRecord(recordOf({ _tag: "Probe" }, [failure]), policy);
        const received = acrossTheWire(Ingest.payloadSchema, {
          attachmentId: "attachment-1",
          records: [
            { ...encoded, category: "state", timeline: "state", reason: "refresh", workId: 1 },
          ],
          droppedSince: 0,
        });
        const { causes } = received.records[0]?.failures[0] as {
          readonly causes: ReadonlyArray<{ readonly path?: unknown }>;
        };

        expect(causes[0]?.path).toEqual(expected);
      }
    });
  }
});
