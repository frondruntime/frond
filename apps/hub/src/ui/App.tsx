import type { EncodedEventRecord } from "@frondruntime/devtools";
import { useNode } from "@frondruntime/react";
import { Sparkline } from "@pppp606/ink-chart";
import { Box, Text, useApp, useWindowSize } from "ink";
import { observer } from "mobx-react-lite";
import { type ReactNode, useEffect, useState } from "react";
import type { AttachmentView } from "../nodes/attachments.ts";
import { DashboardNode } from "../nodes/dashboard.ts";
import type { HubConfigArgs } from "../nodes/hubConfig.ts";
import { HubServerNode } from "../nodes/hubServer.ts";
import { advanceRate, RATE_BUCKET_MS } from "../rate.ts";
import {
  clip,
  clock,
  count,
  downsample,
  pad,
  padStart,
  severityColor,
  timelineColor,
  tint,
} from "./format.ts";
import { useDashboardKeys } from "./keys.ts";

export type HubAppProps = {
  /**
   * How to address the server node — the same args the CLI created it with.
   *
   * Passed whole rather than reassembled from parts: which fields form the key
   * is the node's business, and a UI that picks two of the three out is a UI
   * that breaks when a third is added.
   */
  readonly server: HubConfigArgs;
};

const NAME_WIDTH = 20;
const PLATFORM_WIDTH = 9;
const COUNT_WIDTH = 10;
const SPARK_WIDTH = 20;

const SEQUENCE_WIDTH = 7;
const TIMELINE_WIDTH = 7;
const TAG_WIDTH = 30;

/**
 * Everything on an event line before the node id, plus the screen's own
 * padding. What is left of the terminal width is the node id's budget.
 */
const EVENT_PREFIX_WIDTH = SEQUENCE_WIDTH + 1 + 12 + 1 + TIMELINE_WIDTH + TAG_WIDTH + 3;

/** Rows the layout spends on chrome: header, three rules, summary, footer. */
const CHROME_ROWS = 6;

/** Never collapse the tail entirely, even on a very short terminal. */
const MIN_TAIL_ROWS = 3;

/**
 * The hub's own view of itself.
 *
 * Everything on screen is read from `hub/dashboard`, which is a Frond node like
 * any other — the ordering, the cursor, the pause snapshot and the filter are
 * graph state, and this file is the part that turns them into characters. That
 * split is deliberate dogfooding: the rules worth testing live where they can
 * be tested, and what is left here is layout.
 *
 * `observer` is what makes it move. `useNode` re-renders on graph-level changes
 * only, and an ingested batch replaces an entry in an observable map without
 * touching the graph.
 */
export const HubApp = observer(function HubApp({ server: args }: HubAppProps): ReactNode {
  const server = useNode(HubServerNode, args);
  const dashboard = useNode(DashboardNode, { selfInstanceId: args.selfInstanceId });
  const size = useWindowSize();
  const { exit } = useApp();
  // Whether keystrokes are going into the filter box. Terminal input focus, not
  // application state: it does not survive a restart, nothing else derives from
  // it, and the text it edits already lives on the node.
  const [editing, setEditing] = useState(false);

  const now = useWallClock();
  const view = dashboard.result;
  const rows = view.rows;
  const selected = view.selected;

  // Piping the hub's output somewhere is a reasonable thing to do, and stdin is
  // not a terminal when you do, so `interactive` comes back false and the keys
  // go quiet while the dashboard keeps rendering. Everything the handler reads
  // it reads live — see the note on the hook for the reconciler bug that makes
  // that mandatory rather than tidy.
  const interactive = useDashboardKeys({ dashboard, editing, setEditing, exit });

  const tailRows = Math.max(MIN_TAIL_ROWS, size.rows - CHROME_ROWS - Math.max(rows.length, 1));
  const tail = view.tail.slice(-tailRows);

  return (
    <Box flexDirection="column" height={size.rows} paddingX={1}>
      <Box>
        <Text bold color="green">
          frond hub
        </Text>
        <Text dimColor> {server.result.attachUrl}</Text>
        <Box flexGrow={1} />
        <Text dimColor>{rows.length === 1 ? "1 attached" : `${rows.length} attached`}</Text>
      </Box>

      <Rule width={size.columns} />

      {rows.length === 0 ? (
        <Text dimColor>waiting for a runtime to attach</Text>
      ) : (
        rows.map((row) => (
          <AttachmentRow
            key={row.attachmentId}
            row={row}
            now={now}
            isSelf={view.isSelf(row)}
            isSelected={row.attachmentId === selected?.attachmentId}
          />
        ))
      )}

      <Rule width={size.columns} />

      <Summary selected={selected} shown={tail.length} paused={view.paused} filter={view.filter} />

      <Box flexDirection="column" flexGrow={1}>
        {tail.map((record) => (
          <EventLine key={record.sequence} record={record} width={size.columns} />
        ))}
      </Box>

      <Rule width={size.columns} />

      {!interactive ? (
        <Text dimColor>read-only · stdin is not a terminal</Text>
      ) : editing ? (
        <Box>
          <Text color="cyan">/{view.filter}</Text>
          <Text inverse> </Text>
          <Text dimColor> enter apply · esc clear</Text>
        </Box>
      ) : (
        <Text dimColor>↑↓ select · p pause · / filter · q quit</Text>
      )}
    </Box>
  );
});

const AttachmentRow = observer(function AttachmentRow({
  row,
  now,
  isSelf,
  isSelected,
}: {
  readonly row: AttachmentView;
  readonly now: number;
  readonly isSelf: boolean;
  readonly isSelected: boolean;
}): ReactNode {
  // Rolled forward at render against the wall clock. The window only moves when
  // events arrive, so an app that went quiet would otherwise keep showing the
  // second it went quiet in — wrong exactly when someone is looking to find out
  // whether it stopped.
  const buckets = advanceRate(row.rate, now).buckets;

  return (
    <Box>
      <Text {...tint(isSelected ? "cyan" : undefined)}>{isSelected ? "▸ " : "  "}</Text>
      <Text bold={isSelected} {...tint(isSelf ? "gray" : undefined)}>
        {pad(row.info.name, NAME_WIDTH)}
      </Text>
      <Text dimColor>{pad(row.info.platform, PLATFORM_WIDTH)}</Text>
      <Text>{padStart(count(row.eventCount), COUNT_WIDTH)}</Text>
      {/* Dropped is never inferred and never hidden: a feed with a silent gap
          is worse than one that admits to it. */}
      <Text {...tint(row.droppedCount > 0 ? "yellow" : undefined)}>
        {padStart(row.droppedCount > 0 ? `${count(row.droppedCount)} drop` : "", COUNT_WIDTH + 5)}
      </Text>
      <Text> </Text>
      {isSelf ? <Text dimColor>(self)</Text> : <Spark buckets={buckets} />}
    </Box>
  );
});

/**
 * One row's events-per-second over the last minute.
 *
 * Downsampled here rather than by passing a width to `Sparkline`: that scales by
 * picking every nth bucket, so a one-second burst between two samples simply
 * disappears. Taking the maximum of each group keeps the spike, which is the
 * only thing anyone reads a sparkline for.
 *
 * The domain is pinned to zero for the same reason. Left on `auto` the chart
 * scales to its own min and max, which renders a completely idle app — sixty
 * identical zeroes — as a solid half-height bar.
 */
function Spark({ buckets }: { readonly buckets: ReadonlyArray<number> }): ReactNode {
  const data = downsample(buckets, SPARK_WIDTH);
  const peak = Math.max(...data);

  if (peak === 0) {
    return <Text dimColor>{"·".repeat(SPARK_WIDTH)}</Text>;
  }

  return <Sparkline data={data} width="auto" mode="block" yDomain={[0, peak]} />;
}

const Summary = observer(function Summary({
  selected,
  shown,
  paused,
  filter,
}: {
  readonly selected: AttachmentView | undefined;
  readonly shown: number;
  readonly paused: boolean;
  readonly filter: string;
}): ReactNode {
  if (selected === undefined) {
    return <Text dimColor>no runtime selected</Text>;
  }

  return (
    <Box>
      <Text color="cyan">{selected.info.name}</Text>
      <Text dimColor>{` · ${count(selected.eventCount)} events · showing ${shown}`}</Text>
      {filter === "" ? undefined : <Text color="cyan">{` · /${filter}`}</Text>}
      {paused ? <Text color="yellow"> · paused</Text> : undefined}
    </Box>
  );
});

function EventLine({
  record,
  width,
}: {
  readonly record: EncodedEventRecord;
  readonly width: number;
}): ReactNode {
  const nodeId = record.nodeIds[0];
  const extra = record.nodeIds.length > 1 ? ` +${record.nodeIds.length - 1}` : "";

  return (
    <Box>
      {/* One string, not two Texts with a space between them: JSX drops
          whitespace at the end of an element, which silently glued the
          sequence number to the timestamp. */}
      <Text dimColor>{`${padStart(`#${record.sequence}`, SEQUENCE_WIDTH)} ${clock(
        record.recordedAt
      )} `}</Text>
      <Text {...tint(timelineColor(record.timeline))}>{pad(record.timeline, TIMELINE_WIDTH)}</Text>
      <Text {...tint(severityColor(record.severity))}>{pad(record.tag, TAG_WIDTH)}</Text>
      {/* Clipped to the remaining width, and `truncate` behind it as a
          backstop: a line that wraps costs a whole event of tail, and the
          event it costs is the one at the top of the screen. */}
      <Text dimColor wrap="truncate">
        {clip(`${nodeId ?? ""}${extra}`, Math.max(0, width - EVENT_PREFIX_WIDTH))}
      </Text>
    </Box>
  );
}

function Rule({ width }: { readonly width: number }): ReactNode {
  return <Text dimColor>{"─".repeat(Math.max(0, width - 2))}</Text>;
}

/**
 * A render clock, ticking once per rate bucket.
 *
 * The sparklines decay with wall time, not with arriving events, so something
 * has to re-render an idle screen. A hook rather than a node: this is the
 * refresh rate of a terminal, and putting it in the graph would emit runtime
 * events once a second forever.
 */
function useWallClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RATE_BUCKET_MS);

    return () => clearInterval(timer);
  }, []);

  return now;
}
