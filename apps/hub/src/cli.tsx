#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { createRuntime } from "@frondruntime/core";
import { attachDevtools, HUB_DEFAULT_HOST, HUB_DEFAULT_PORT } from "@frondruntime/devtools";
import { FrondProvider } from "@frondruntime/react";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { render } from "ink";
import { isHubInternal } from "./hubInternal.ts";
import { HubServerNode } from "./nodes/hubServer.ts";
import { HubApp } from "./ui/App.tsx";
import { HUB_VERSION } from "./version.ts";

const runHub = Effect.fnUntraced(function* (config: {
  readonly host: string;
  readonly port: number;
}) {
  const runtime = createRuntime();

  yield* Effect.addFinalizer(() =>
    Effect.ignore(Effect.promise(() => runtime.submit({ _tag: "RuntimeStop", reason: "hub exit" })))
  );
  yield* Effect.promise(() => runtime.submit({ _tag: "RuntimeStart" }));

  // Minted once and handed to both halves of the self-attachment below, because
  // that identity is the only thing that lets the hub find its own row in the
  // list it serves. Deliberately not `runtimeId`: that is a per-process counter,
  // so every process's first runtime is `runtime-1` and the comparison would
  // quietly claim every attached app is the hub.
  const selfInstanceId = crypto.randomUUID();

  const serverArgs = {
    host: config.host,
    port: config.port,
    selfInstanceId,
  };

  // Started before Ink takes the terminal: a port collision should print a
  // plain error, not flash inside a half-rendered frame.
  const handle = runtime.client.node(HubServerNode, serverArgs);
  const server = yield* Effect.tryPromise(() => handle.ensureReadyNode());

  const ink = render(
    <FrondProvider runtime={runtime}>
      <HubApp server={serverArgs} />
    </FrondProvider>,
    {
      // Ink's own alternate-screen handling, not hand-rolled escape codes: it
      // restores the terminal on unmount *and* on a crash, which is the case
      // that matters — a devtool that leaves someone's shell in a broken state
      // has cost more than it showed.
      alternateScreen: true,
    }
  );

  yield* Effect.addFinalizer(() => Effect.sync(() => ink.unmount()));

  // The hub attaches to itself over its own socket, through the same public
  // entry point an app uses — no in-process shortcut and no privileged path.
  // That makes the first attachment a real end-to-end test of the shipped
  // client on every boot, and it means the hub reports on itself the way it
  // reports on anything else.
  //
  // `"full"` for its own row because the hub is the one runtime whose values
  // are not anybody's data. Attached apps get the `"shape"` default until they
  // say otherwise.
  //
  // The instrument does not instrument itself — see `isHubInternal`. Without
  // that exclusion, applying a batch emits the events that make up the next
  // batch, and the hub's own row climbs forever on an idle machine.
  const detach = attachDevtools({
    runtime,
    url: server.result.attachUrl,
    name: "frond-hub",
    platform: "bun",
    values: "full",
    instanceId: selfInstanceId,
    include: (record) => !isHubInternal(record),
  });

  yield* Effect.addFinalizer(() => Effect.sync(detach));

  yield* Effect.promise(() => ink.waitUntilExit());
});

const hub = Command.make(
  "frond-hub",
  {
    host: Flag.string("host").pipe(
      Flag.withDefault(HUB_DEFAULT_HOST),
      Flag.withDescription("Interface to bind. Leave on loopback unless you mean it.")
    ),
    port: Flag.integer("port").pipe(
      Flag.withDefault(HUB_DEFAULT_PORT),
      Flag.withDescription("Port to listen on for attaching runtimes.")
    ),
  },
  (config) => Effect.scoped(runHub(config))
).pipe(Command.withDescription("Run the Frond devtools hub and wait for runtimes to attach."));

Command.run(hub, { version: HUB_VERSION }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
);
