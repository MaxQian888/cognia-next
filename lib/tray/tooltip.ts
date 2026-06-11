// Dynamic tray tooltip — the hover text mature trays use to surface state at
// a glance ("Cognia — Goal: Ship the release"). Derived from the same status
// snapshot that drives the menu so the tooltip and the status row agree.
//
// The OS caps tooltip length (Windows historically ~127 chars), so the goal
// objective is truncated before it is appended.

import { deriveStatusKey, truncateTitle } from "./status-section"
import type { TrayStateSnapshot } from "./types"

/** Max characters of the goal objective appended to the tooltip. */
export const TOOLTIP_TITLE_MAX = 40

/** Single-argument translator (matches the resilient builder translator). */
export type TrayTooltipTranslator = (key: string) => string

/**
 * Compose the tooltip string. Idle state returns the plain base ("Cognia");
 * any active state appends a localized status, plus the redacted goal
 * objective when one is open.
 */
export function deriveTrayTooltip(
  snapshot: TrayStateSnapshot,
  t: TrayTooltipTranslator,
  base = "Cognia"
): string {
  const key = deriveStatusKey(snapshot)
  if (key === "tray.status.idle") return base

  let label = t(key)
  const title = snapshot.goal.title?.trim()
  if ((snapshot.goal.active || snapshot.goal.paused) && title) {
    label = `${label}: ${truncateTitle(title, TOOLTIP_TITLE_MAX)}`
  }
  return `${base} — ${label}`
}
