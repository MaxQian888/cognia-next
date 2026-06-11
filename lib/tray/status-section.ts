// Live status rows injected at the top of the tray menu — the "information"
// half of a mature tray (think Docker Desktop's "Docker Desktop is running"
// header). The renderer's `buildTrayPayload` swaps the synthetic
// `tray.status` placeholder for the rows this module produces.
//
// Rows are disabled (non-interactive) info items. Labels are either i18n keys
// (resolved by the builder's translator) or literal strings (passed through
// unchanged by the resilient translator). The goal-detail row uses the
// PII-redacted `safeObjective` only — never the raw objective — because the
// OS tray is a screenshot-able surface.

import type { TrayMenuItem, TrayStateSnapshot } from "./types"

/** Max characters of the goal objective shown in the detail row. */
export const GOAL_TITLE_MAX = 48

/**
 * Derive the single i18n key that names the app's current primary state.
 * Priority is alert-first: a running automation outranks an active goal,
 * which outranks raw streaming. Shared with `lib/tray/tooltip.ts` so the
 * tooltip and the status row never disagree.
 */
export function deriveStatusKey(snapshot: TrayStateSnapshot): string {
  if (snapshot.automation.running) return "tray.status.automationRunning"
  if (snapshot.goal.active) return "tray.status.goalRunning"
  if (snapshot.goal.paused) return "tray.status.goalPaused"
  if (snapshot.chat.streaming) return "tray.status.streaming"
  return "tray.status.idle"
}

/** Trim an objective to a single tidy line for the menu / tooltip. */
export function truncateTitle(title: string, max: number = GOAL_TITLE_MAX): string {
  const oneLine = title.replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Build the disabled info rows for the live status section. Always emits the
 * primary status row; appends a second row with the (redacted, truncated)
 * goal objective when a goal is open and carries a title.
 */
export function buildStatusSection(snapshot: TrayStateSnapshot): TrayMenuItem[] {
  const rows: TrayMenuItem[] = [
    {
      kind: "action",
      id: "tray.status.primary",
      label: deriveStatusKey(snapshot),
      disabled: true,
      payload: { kind: "native", action: "noop" },
    },
  ]

  const hasGoal = snapshot.goal.active || snapshot.goal.paused
  const title = snapshot.goal.title?.trim()
  if (hasGoal && title) {
    rows.push({
      kind: "action",
      id: "tray.status.goal",
      label: truncateTitle(title),
      disabled: true,
      payload: { kind: "native", action: "noop" },
    })
  }

  return rows
}
