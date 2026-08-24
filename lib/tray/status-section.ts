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

import { NEUTRAL_MOOD_CEILING, UNWELL_NEED_THRESHOLD } from "@/lib/pet/care/condition"
import type { TrayMenuItem, TrayStateSnapshot } from "./types"

/**
 * Translator for the one status row that needs a number. Widened beyond the
 * builder's `(key) => string` because a count cannot be baked into a key.
 */
export type StatusRowTranslator = (key: string, values?: Record<string, unknown>) => string

/** Max characters of the goal objective shown in the detail row. */
export const GOAL_TITLE_MAX = 48

/**
 * Coarse 3-band mood indicator for the tray (a screenshot-able OS surface —
 * exact percentages are more precision than useful at a glance, mirroring
 * the widget's own needs→mood banding in `lib/pet/state/reducer.ts`).
 */
export function petMoodEmoji(pet: NonNullable<TrayStateSnapshot["pet"]>): string {
  const worst = Math.min(pet.energy, pet.mood)
  if (worst < UNWELL_NEED_THRESHOLD) return "😟"
  if (worst < NEUTRAL_MOOD_CEILING) return "😐"
  return "😊"
}

/**
 * Derive the single i18n key that names the app's current primary state.
 * Priority is alert-first: a running automation outranks an active goal,
 * which outranks raw streaming, which outranks the pet needing attention —
 * ambient pet-care is the lowest-priority signal, shown only when nothing
 * else is going on. Shared with `lib/tray/tooltip.ts` so the tooltip and the
 * status row never disagree.
 */
export function deriveStatusKey(snapshot: TrayStateSnapshot): string {
  if (snapshot.automation.running) return "tray.status.automationRunning"
  if (snapshot.goal.active) return "tray.status.goalRunning"
  if (snapshot.goal.paused) return "tray.status.goalPaused"
  // Above streaming: a run blocked on a decision the user has not been shown
  // is the worst thing for an OS-level surface to hide.
  if (snapshot.chat.awaitingApproval) return "tray.status.awaitingApproval"
  if (snapshot.chat.streaming) return "tray.status.streaming"
  if (
    snapshot.pet?.enabled &&
    Math.min(snapshot.pet.energy, snapshot.pet.mood) < UNWELL_NEED_THRESHOLD
  ) {
    return "tray.status.petNeedsAttention"
  }
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
export function buildStatusSection(
  snapshot: TrayStateSnapshot,
  t?: StatusRowTranslator
): TrayMenuItem[] {
  const rows: TrayMenuItem[] = [
    {
      kind: "action",
      id: "tray.status.primary",
      label: deriveStatusKey(snapshot),
      disabled: true,
      payload: { kind: "native", action: "noop" },
    },
  ]

  // "Responding…" is true of one conversation and of five. Concurrency is
  // invisible without the number, and the number is the reason the user would
  // open the app rather than assume one turn is nearly done. Only when there
  // is more than one: for a single run the primary row already says it.
  const activeCount = snapshot.chat.activeCount ?? 0
  if (activeCount > 1) {
    rows.push({
      kind: "action",
      id: "tray.status.running",
      // Already-translated, because the count needs interpolation. The
      // builder's resilient translator passes an unknown key through
      // unchanged, so a literal survives `t(label)` intact.
      label: t ? t("tray.status.runningCount", { count: activeCount }) : `tray.status.runningCount`,
      disabled: true,
      payload: { kind: "native", action: "noop" },
    })
  }

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

  if (snapshot.pet?.enabled) {
    rows.push({
      kind: "action",
      id: "tray.status.pet",
      // Literal (not an i18n key) — the resilient builder translator passes
      // unknown keys through unchanged, same as the goal-title row above.
      label: petMoodEmoji(snapshot.pet),
      disabled: true,
      payload: { kind: "native", action: "noop" },
    })
  }

  return rows
}
