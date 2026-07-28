import { Driver, Key, NodeBase, type NodeSpec, serviceSpec, tag } from "@frondruntime/core";
import { HUB_ATTACH_PATH } from "@frondruntime/devtools";
import { Effect } from "effect";

export type HubConfigArgs = {
  readonly host: string;
  readonly port: number;
  /**
   * The `instanceId` the hub uses when it attaches to itself.
   *
   * Minted by the caller and handed to both sides, because the hub has to be
   * able to point at its own row in the list it serves — a reader that mistakes
   * the instrument's events for the app's draws conclusions about the wrong
   * program.
   *
   * Explicitly not `runtimeId`: that comes from a per-process counter, so two
   * unrelated processes both report `runtime-1` and the comparison silently
   * matches everything. It is a label, not an identity.
   *
   * Not part of the key. Two hubs on one port are the same hub.
   */
  readonly selfInstanceId: string;
};

export type HubConfigResult = {
  readonly host: string;
  readonly port: number;
  readonly attachUrl: string;
  /**
   * Where this hub advertises itself, named by port.
   *
   * Per-port rather than a single `hub.json` because two hubs in one working
   * directory is a normal thing to do — a project hub and a scratch one — and a
   * shared path would have them silently overwriting each other. The port is
   * already the hub's identity; the filename just follows it.
   */
  readonly lockfilePath: string;
};

type HubConfigSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: HubConfigArgs;
  readonly key: Key.Structure<{ readonly host: string; readonly port: number }>;
  readonly result: HubConfigResult;
}>;

/**
 * Resolved listen configuration for one hub instance.
 *
 * Keyed on host and port rather than singleton so that changing where the hub
 * listens is a different node, not a mutation of a running one — the server
 * node keys the same way and follows it.
 */
export class HubConfigNode extends NodeBase<HubConfigSpec> {
  static readonly spec = serviceSpec.effect<HubConfigSpec>({
    tag: tag("hub/config"),
    key: (args) => Key.structure({ host: args.host, port: args.port }),
    acquire: Driver.Acquire((ctx) =>
      Effect.sync(() => ({
        host: ctx.args.host,
        port: ctx.args.port,
        attachUrl: `ws://${ctx.args.host}:${ctx.args.port}${HUB_ATTACH_PATH}`,
        lockfilePath: `${process.cwd()}/.frond/hub-${ctx.args.port}.json`,
      }))
    ),
  });
}
