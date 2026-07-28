import { useInput, useStdin } from "ink";
import { useEffect, useRef } from "react";
import type { DashboardNode } from "../nodes/dashboard.ts";

export type DashboardKeysOptions = {
  readonly dashboard: DashboardNode;
  /** Whether keystrokes are going into the filter box. */
  readonly editing: boolean;
  readonly setEditing: (editing: boolean) => void;
  readonly exit: () => void;
};

/**
 * Keyboard handling for the dashboard.
 *
 * Its own hook, and pointedly not reading anything off the render that installed
 * it. Ink's `useInput` is built on React's `useEffectEvent`, which refreshes the
 * live implementation during commit — but react-reconciler 0.33 only does that
 * for plain function-component fibers. `memo` ones fall through a bare `break`,
 * and `observer` wraps every component it touches in `memo`. The handler an
 * observer component installs is therefore the one from its *first* render, for
 * the life of the process.
 *
 * That is invisible until you look for it: the screen updates perfectly, because
 * rendering is a separate mechanism that works. Only the keys are frozen. It
 * cost the cursor (every press computed from the same starting row), pause
 * (`!paused` off a `paused` that never stopped being false) and the filter
 * (every keystroke appended to the empty string it started at) — one defect
 * wearing three costumes.
 *
 * So nothing here closes over render output. The node is the state, and this
 * reads it at keypress time through a ref that survives the stale closure.
 *
 * @returns Whether keys are live at all, which the footer says out loud.
 */
export function useDashboardKeys(options: DashboardKeysOptions): boolean {
  // Ink throws rather than degrading if a keyboard handler is installed without
  // raw mode, so the keys are what turn off when stdin is not a terminal — the
  // dashboard still renders, it just stops taking input.
  //
  // Compared rather than used: Ink types `isRawModeSupported` as a boolean but
  // sources it from `stdin.isTTY`, which Node leaves *undefined* off a terminal.
  // Passing that straight through reads as "not specified" and installs the
  // handler anyway, which is the throw this is here to avoid.
  const interactive = useStdin().isRawModeSupported === true;

  // The one object the frozen handler is allowed to reach through. Written after
  // commit rather than during render so a concurrent render that is thrown away
  // cannot leave its values behind.
  const live = useRef(options);

  useEffect(() => {
    live.current = options;
  });

  useInput(
    (input, key) => {
      const { dashboard, editing, setEditing, exit } = live.current;
      const view = dashboard.result;

      if (editing) {
        if (key.return) {
          setEditing(false);
          return;
        }

        // Escape clears rather than reverting. There is no draft to revert to —
        // the filter applies as it is typed — so the useful escape is the one
        // that gets the whole feed back in one keystroke.
        if (key.escape) {
          setEditing(false);
          fire(dashboard.filterChanged(""));
          return;
        }

        if (key.backspace || key.delete) {
          fire(dashboard.filterChanged(view.filter.slice(0, -1)));
          return;
        }

        if (input !== "" && !key.ctrl && !key.meta) {
          fire(dashboard.filterChanged(view.filter + input));
        }

        return;
      }

      if (input === "q") {
        exit();
        return;
      }

      if (input === "p") {
        fire(dashboard.pauseChanged(!view.paused));
        return;
      }

      if (input === "/") {
        setEditing(true);
        return;
      }

      if (key.upArrow || key.downArrow) {
        const rows = view.rows;
        const step = key.downArrow ? 1 : -1;
        const at = rows.findIndex((row) => row.attachmentId === view.selected?.attachmentId);
        // Clamped, not wrapped: with two or three rows a wrap reads as the cursor
        // jumping at random rather than running off the end.
        const next = rows[Math.min(rows.length - 1, Math.max(0, at + step))];

        if (next !== undefined) {
          fire(dashboard.selectionChanged(next.attachmentId));
        }
      }
    },
    { isActive: interactive }
  );

  return interactive;
}

/**
 * Fires an action and drops its promise.
 *
 * These are keystroke handlers: there is nowhere to render a failure and no
 * meaningful retry, and an unhandled rejection would take the process down
 * mid-frame. Swallowing is the honest choice, not an oversight.
 */
function fire(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}
