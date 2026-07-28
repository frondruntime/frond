import {
  type ActionContract,
  Args,
  type Dep,
  Driver,
  dep,
  dependencies,
  facadeSpec,
  internalOf,
  Key,
  NodeBase,
  type NodeSpec,
  tag,
  type WithInternal,
  withInternal,
} from "@frondruntime/core";
import type { EncodedEventRecord } from "@frondruntime/devtools";
import { observable, runInAction } from "mobx";
import { AttachmentsNode, type AttachmentView } from "./attachments.ts";

/**
 * What the dashboard shows, derived on read.
 *
 * Every field but `paused` and `filter` is a getter over the attachments node's
 * observable map, so a component wrapped in `observer` re-renders when the
 * underlying entry changes without this node having to be told about it.
 */
export type DashboardResult = {
  /** Attached runtimes in display order: oldest first, the hub itself last. */
  readonly rows: ReadonlyArray<AttachmentView>;
  /** The row the cursor is on, falling back to the first when nothing is set. */
  readonly selected: AttachmentView | undefined;
  /** Recent records for `selected`, frozen while paused and filtered if asked. */
  readonly tail: ReadonlyArray<EncodedEventRecord>;
  readonly paused: boolean;
  readonly filter: string;
  /**
   * Whether a row is the hub's own self-attachment.
   *
   * A predicate rather than an exposed id: how the hub recognises itself has
   * already changed once, and every caller that compares fields itself is a
   * place that has to change again.
   */
  readonly isSelf: (view: AttachmentView) => boolean;
};

export type DashboardArgs = {
  /** The hub's own attachment identity — see `HubConfigArgs.selfInstanceId`. */
  readonly selfInstanceId: string;
};

type DashboardDeps = {
  readonly attachments: Dep<typeof AttachmentsNode>;
};

type DashboardSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: DashboardArgs;
  readonly key: Key.Singleton;
  readonly deps: DashboardDeps;
  readonly result: DashboardNodeResult;
  readonly actions: {
    readonly selectionChanged: ActionContract<{ readonly attachmentId: string }, void>;
    readonly pauseChanged: ActionContract<{ readonly paused: boolean }, void>;
    readonly filterChanged: ActionContract<{ readonly filter: string }, void>;
  };
}>;

type DashboardState = {
  selectedId: string | undefined;
  paused: boolean;
  filter: string;
  frozenTail: ReadonlyArray<EncodedEventRecord>;
};

/**
 * The mutable half of the result, kept off the public surface.
 *
 * Carried in the core envelope slot rather than as a field, because the slot is
 * non-enumerable: the UI reads derived values and calls actions, and a writable
 * `selectedId` sitting on the result is an invitation to skip the action and
 * mutate outside the serialization the cell actor provides.
 */
type DashboardInternal = {
  readonly state: DashboardState;
  readonly selectedOf: () => AttachmentView | undefined;
};

export type DashboardNodeResult = WithInternal<DashboardResult, DashboardInternal>;

/**
 * The UI's view of the hub.
 *
 * A facade because that is what it is: the Ink app reads this one node instead
 * of assembling ordering, self-demotion, cursor fallback and filtering out of
 * `hub/attachments` in JSX. Those rules are testable here and were not there.
 *
 * Async mode, unlike every other node in the hub, because React is what drives
 * it — actions return promises the UI can fire directly, with no Effect
 * ceremony at the callsite.
 *
 * The cursor lives here rather than in `useState` on the deliberate reading that
 * this *is* app state: it survives a remount, it is what pause freezes, and
 * putting it in the graph is what lets the pause snapshot be taken atomically
 * with the state that says it is paused.
 */
export class DashboardNode extends NodeBase<DashboardSpec> {
  static readonly spec = facadeSpec.async<DashboardSpec>({
    tag: tag("hub/dashboard"),
    // Not keyed by `selfInstanceId`: one process has one hub and one dashboard,
    // and keying on it would mint a second node rather than correct the first.
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      attachments: dep(AttachmentsNode, Args.none),
    })),
    acquire: Driver.Acquire((ctx): DashboardNodeResult => {
      const views = ctx.deps.attachments.result.attachments;
      const selfInstanceId = ctx.args.selfInstanceId;

      // Shallow: `frozenTail` is replaced wholesale, never mutated, and deep
      // observation would walk a hundred records to learn that.
      const state = observable.object<DashboardState>(
        { selectedId: undefined, paused: false, filter: "", frozenTail: [] },
        {},
        { deep: false }
      );

      const isSelf = (view: AttachmentView): boolean => view.info.instanceId === selfInstanceId;

      const rowsOf = (): ReadonlyArray<AttachmentView> =>
        [...views.values()].sort((left, right) => {
          // The hub sinks to the bottom. It is always attached, it is never the
          // thing being debugged, and left in arrival order it is the row the
          // cursor lands on when a fresh hub has nothing else to show.
          const bySelf = Number(isSelf(left)) - Number(isSelf(right));

          return bySelf !== 0 ? bySelf : left.connectedAt - right.connectedAt;
        });

      const selectedOf = (): AttachmentView | undefined => {
        const rows = rowsOf();

        // Falls back rather than clearing: an attachment can detach while the
        // cursor is on it, and a dashboard that empties itself in response is
        // less useful than one that moves to whatever is still there.
        return rows.find((row) => row.attachmentId === state.selectedId) ?? rows[0];
      };

      const tailOf = (): ReadonlyArray<EncodedEventRecord> => {
        const source = state.paused ? state.frozenTail : (selectedOf()?.tail ?? []);
        const needle = state.filter.trim().toLowerCase();

        if (needle === "") {
          return source;
        }

        return source.filter(
          (record) =>
            record.tag.toLowerCase().includes(needle) ||
            record.nodeIds.some((nodeId) => nodeId.toLowerCase().includes(needle))
        );
      };

      const view: DashboardResult = {
        get rows() {
          return rowsOf();
        },
        get selected() {
          return selectedOf();
        },
        get tail() {
          return tailOf();
        },
        get paused() {
          return state.paused;
        },
        get filter() {
          return state.filter;
        },
        isSelf,
      };

      return withInternal(view, { state, selectedOf });
    }),
    actions: {
      selectionChanged: Driver.Action((ctx, input) => {
        const { state, selectedOf } = internalOf(ctx.node.result);

        runInAction(() => {
          state.selectedId = input.attachmentId;
          // Re-snapshot, because the freeze is of one attachment's tail and the
          // cursor just moved to another. Keeping the old one would put the new
          // attachment's name in the header above the old attachment's events,
          // with nothing on screen to say the two disagree.
          if (state.paused) {
            state.frozenTail = selectedOf()?.tail ?? [];
          }
        });
      }),
      pauseChanged: Driver.Action((ctx, input) => {
        const { state, selectedOf } = internalOf(ctx.node.result);

        runInAction(() => {
          state.paused = input.paused;
          // Snapshotting is the whole point of pausing. Without it the tail
          // keeps rolling underneath a stopped cursor, and the records someone
          // paused in order to read are the first ones pushed off the end.
          state.frozenTail = input.paused ? (selectedOf()?.tail ?? []) : [];
        });
      }),
      filterChanged: Driver.Action((ctx, input) => {
        runInAction(() => {
          internalOf(ctx.node.result).state.filter = input.filter;
        });
      }),
    },
  });

  selectionChanged(attachmentId: string): Promise<void> {
    return this.actions.selectionChanged({ attachmentId });
  }

  pauseChanged(paused: boolean): Promise<void> {
    return this.actions.pauseChanged({ paused });
  }

  filterChanged(filter: string): Promise<void> {
    return this.actions.filterChanged({ filter });
  }
}
