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
 * objective when one is open. `usageText` (the pinned subscription's compact
 * readout, see `lib/tray/usage.ts:usageTooltipFragment`) is appended last
 * when the user enabled the tooltip usage surface.
 */
export function deriveTrayTooltip(
  snapshot: TrayStateSnapshot,
  t: TrayTooltipTranslator,
  base = "Cognia",
  usageText?: string | null
): string {
  const key = deriveStatusKey(snapshot)
  let text = base
  if (key !== "tray.status.idle") {
    let label = t(key)
    const title = snapshot.goal.title?.trim()
    if ((snapshot.goal.active || snapshot.goal.paused) && title) {
      label = `${label}: ${truncateTitle(title, TOOLTIP_TITLE_MAX)}`
    }
    text = `${base} — ${label}`
  }
  return usageText ? `${text} · ${usageText}` : text
}
