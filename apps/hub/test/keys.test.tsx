import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Args, createRuntime } from "@frondruntime/core";
import type { AttachmentInfo, HubCommand } from "@frondruntime/devtools";
import { HUB_PROTOCOL_VERSION } from "@frondruntime/devtools";
import { FrondProvider, useNode } from "@frondruntime/react";
import { Effect, Queue } from "effect";
import { Box, render, Text } from "ink";
import { observer } from "mobx-react-lite";
import { type ReactNode, useState } from "react";
import { AttachmentsNode } from "../src/nodes/attachments.ts";
import { DashboardNode } from "../src/nodes/dashboard.ts";
import { useDashboardKeys } from "../src/ui/keys.ts";

const SELF_INSTANCE_ID = "hub-self";

const DOWN = "[B";
const UP = "[A";
const ESCAPE = "";

/** Long enough for Ink to commit and for an action to round-trip the cell. */
const SETTLE_MS = 60;

const teardown: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) {
    await teardown.pop()?.();
  }
});

/**
 * Drives the real key handler through Ink, against the real dashboard node.
 *
 * Heavier than testing a reducer, and deliberately so: the defect these cover
 * was not in any branch of the handler, it was that an `observer` component
 * installs its keyboard handler once and React never refreshes what that
 * handler can see. Nothing short of pressing a key twice can catch it, because
 * the first press is always correct.
 */
async function screen(): Promise<{
  readonly press: (sequence: string) => Promise<void>;
  readonly dashboard: DashboardNode;
}> {
  const runtime = createRuntime();
  await runtime.submit({ _tag: "RuntimeStart" });

  teardown.push(async () => {
    await runtime.submit({ _tag: "RuntimeStop", reason: "test teardown" });
  });

  const attachments = await runtime.client.node(AttachmentsNode, Args.none).ensureReadyNode();
  const dashboard = await runtime.client
    .node(DashboardNode, { selfInstanceId: SELF_INSTANCE_ID })
    .ensureReadyNode();

  let clock = 1_000;

  for (const name of ["alpha", "beta", "gamma"]) {
    clock += 1;
    await Effect.runPromise(
      Effect.flatMap(Queue.unbounded<HubCommand>(), (outbound) =>
        attachments.attached(`att-${name}`, info(name), clock, outbound)
      )
    );
  }

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;

  // Ink installs a keyboard handler only where raw mode exists, and calls
  // `setRawMode` on the way in. Neither is on a plain stream.
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });

  const instance = render(
    <FrondProvider runtime={runtime}>
      <Harness />
    </FrondProvider>,
    // A sink for stdout: this asserts on node state, not on characters, and
    // letting Ink write to the test runner's terminal would corrupt its output.
    { stdin, stdout: new PassThrough() as unknown as NodeJS.WriteStream, patchConsole: false }
  );

  teardown.push(() => instance.unmount());

  await settle();

  return {
    press: async (sequence) => {
      stdin.push(sequence);
      await settle();
    },
    dashboard,
  };
}

const Harness = observer(function Harness(): ReactNode {
  const dashboard = useNode(DashboardNode, { selfInstanceId: SELF_INSTANCE_ID });
  const [editing, setEditing] = useState(false);

  useDashboardKeys({ dashboard, editing, setEditing, exit: () => undefined });

  // Reads the same values the real screen does, so the component re-renders on
  // exactly the changes the real one re-renders on.
  const view = dashboard.result;

  return (
    <Box flexDirection="column">
      <Text>{`${view.selected?.info.name ?? "none"} ${String(view.paused)} ${view.filter}`}</Text>
    </Box>
  );
});

function info(name: string): AttachmentInfo {
  return {
    protocolVersion: HUB_PROTOCOL_VERSION,
    instanceId: `instance-${name}`,
    runtimeId: "runtime-1",
    generation: 0,
    name,
    platform: "bun",
    startedAt: 0,
    values: "shape",
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

describe("dashboard keys", () => {
  test("the cursor keeps moving on every press, not just the first", async () => {
    const { press, dashboard } = await screen();

    expect(dashboard.result.selected?.info.name).toBe("alpha");

    await press(DOWN);
    expect(dashboard.result.selected?.info.name).toBe("beta");

    // The press that used to do nothing: the handler recomputed from the row it
    // was mounted on, so every arrow key after the first landed in the same place.
    await press(DOWN);
    expect(dashboard.result.selected?.info.name).toBe("gamma");

    await press(UP);
    expect(dashboard.result.selected?.info.name).toBe("beta");
  });

  test("the cursor stops at the ends rather than wrapping", async () => {
    const { press, dashboard } = await screen();

    await press(UP);
    expect(dashboard.result.selected?.info.name).toBe("alpha");

    await press(DOWN);
    await press(DOWN);
    await press(DOWN);
    expect(dashboard.result.selected?.info.name).toBe("gamma");
  });

  test("pause toggles both ways", async () => {
    const { press, dashboard } = await screen();

    await press("p");
    expect(dashboard.result.paused).toBe(true);

    // Off a stale `paused` this recomputed `!false` a second time and the
    // dashboard could be paused but never resumed.
    await press("p");
    expect(dashboard.result.paused).toBe(false);
  });

  test("the filter accumulates keystrokes and clears on escape", async () => {
    const { press, dashboard } = await screen();

    await press("/");
    await press("g");
    await press("r");
    await press("a");

    // Each keystroke appended to the filter as it was when the handler was
    // installed, so the box never held more than one character.
    expect(dashboard.result.filter).toBe("gra");

    await press(ESCAPE);
    expect(dashboard.result.filter).toBe("");

    // Escape left edit mode, so this is a cursor key again rather than text.
    await press(DOWN);
    expect(dashboard.result.selected?.info.name).toBe("beta");
  });

  test("keys typed into the filter are not commands", async () => {
    const { press, dashboard } = await screen();

    await press("/");
    await press("p");

    expect(dashboard.result.paused).toBe(false);
    expect(dashboard.result.filter).toBe("p");
  });
});
