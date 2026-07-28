import { describe, expect, test } from "bun:test";
import type { Runtime } from "@frondruntime/core";
import { Data } from "effect";
import { createValueEncoder, encodeRecord } from "../src/encode.ts";

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
    event: { _tag: "Probe", value },
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
});
