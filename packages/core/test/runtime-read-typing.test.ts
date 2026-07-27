import { describe, expect, test } from "bun:test";
import { Args, Driver, Key, NodeBase, type NodeSpec, serviceSpec, tag } from "../src";
import { createFrondTestHarness } from "../src/testing";

// Runtime pins for the definitive `Ready.result`/`Ready.node` read contract:
//
// 1. `Ready.result` is always the committed result — there is no
//    runtime-fabricated "Ready with no result" state. `undefined` appears
//    exactly when `undefined` is a valid member of the node's TResult.
// 2. Typed handles expose the ready author-node instance, not `object`.
//
// A production consumer wired the historical `TResult | undefined` ambiguity
// into an auth fail-closed path; these tests pin the answer.

type TokenResult = { readonly token: string };

type TokenSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: TokenResult;
}>;

class TokenNode extends NodeBase<TokenSpec> {
  static readonly spec = serviceSpec.async<TokenSpec>({
    tag: tag("read-typing/token"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire((): TokenResult => ({ token: "secret" })),
  });

  get bearer(): string {
    return `Bearer ${this.result.token}`;
  }
}

// A node whose VALID result type is `undefined`: Ready must still be reachable
// and carry the committed undefined result without any typing contortions.
type ProbeSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Args.None;
  readonly key: Key.Singleton;
  readonly result: undefined;
}>;

class ProbeNode extends NodeBase<ProbeSpec> {
  static readonly spec = serviceSpec.async<ProbeSpec>({
    tag: tag("read-typing/probe"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire((): undefined => undefined),
  });
}

describe("runtime read typing", () => {
  test("Ready.result is the committed result and Ready.node is the typed instance", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(TokenNode, Args.none);
    await handle.ensureReady();

    const read = handle.read();

    expect(read._tag).toBe("Ready");

    if (read._tag !== "Ready") {
      throw new Error(`Expected Ready read, received ${read._tag}.`);
    }

    // Type pins: no `| undefined` widening, no `as ConcreteNode` cast needed.
    read.result satisfies TokenResult;
    read.node satisfies TokenNode;

    // Runtime pins: the committed result and the constructed class instance.
    expect(read.result.token).toBe("secret");
    expect(read.node).toBeInstanceOf(TokenNode);
    expect(read.node.bearer).toBe("Bearer secret");

    // The typed snapshot lookup carries the same contract.
    const lookup = await handle.snapshot();
    expect(lookup._tag).toBe("Found");
    if (lookup._tag === "Found" && lookup.snapshot._tag === "Ready") {
      lookup.snapshot.result satisfies TokenResult;
      lookup.snapshot.node satisfies TokenNode;
      expect(lookup.snapshot.result.token).toBe("secret");
      expect(lookup.snapshot.node).toBeInstanceOf(TokenNode);
    }

    await harness.teardown();
  });

  test("Ready remains reachable when undefined IS the valid result type", async () => {
    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(ProbeNode, Args.none);
    await handle.ensureReady();

    const read = handle.read();

    expect(read._tag).toBe("Ready");

    if (read._tag !== "Ready") {
      throw new Error(`Expected Ready read, received ${read._tag}.`);
    }

    // TResult = undefined types exactly: the committed result is undefined and
    // that is a VALID Ready — consumers keyed on the node's declared result
    // type, not on a phantom "missing result" state.
    read.result satisfies undefined;
    expect(read.result).toBeUndefined();
    expect(read.node).toBeInstanceOf(ProbeNode);

    await harness.teardown();
  });
});
