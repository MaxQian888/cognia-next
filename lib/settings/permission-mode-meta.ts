/**
 * Single-source metadata for the GUI's permission-mode surfaces — the risk
 * tier, the chip/badge tone, and the i18n key under `chat.permissionMode.*`.
 * Mirrors the CLI's `cli/src/tui/state/permission-mode-meta.ts` exhaustive-record
 * pattern so a newly added mode is a compile error until it is described here,
 * and the composer chip, the desktop status bar, and the settings selectors all
 * read the SAME copy instead of hand-maintaining three drifting lists.
 *
 * User-facing text (label + tooltip + "what runs without asking") lives in i18n,
 * keyed by {@link PermissionModeMeta.i18nKey}; this module holds only the
 * non-localized bits (risk, tone) so it stays framework-agnostic and testable.
 */

import type { PermissionMode } from "./permission-mode-escalation"

/** How much a mode relaxes the approval gate. Drives the warning marker + tone. */
export type PermissionRisk = "safe" | "elevated" | "danger"

export interface PermissionModeMeta {
  risk: PermissionRisk
  /** Tailwind text tone for the chip / status-bar segment / settings badge. */
  tone: string
  /** i18n key suffix under `chat.permissionMode.*` (label + tooltip live there). */
  i18nKey: "default" | "acceptEdits" | "plan" | "bypass" | "dontAsk" | "auto"
}

export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  default: { risk: "safe", tone: "text-muted-foreground", i18nKey: "default" },
  acceptEdits: { risk: "elevated", tone: "text-blue-500", i18nKey: "acceptEdits" },
  plan: { risk: "safe", tone: "text-amber-500", i18nKey: "plan" },
  auto: { risk: "elevated", tone: "text-violet-500", i18nKey: "auto" },
  dontAsk: { risk: "elevated", tone: "text-teal-500", i18nKey: "dontAsk" },
  bypassPermissions: { risk: "danger", tone: "text-rose-500", i18nKey: "bypass" },
}

/** Every permission mode, derived from the exhaustive meta record. */
export const PERMISSION_MODES = Object.keys(PERMISSION_MODE_META) as PermissionMode[]

/**
 * The modes the quick affordance (composer chip click + Shift+Tab) cycles
 * through — the safe core only. The power modes ({@link ADVANCED_MODES}) are
 * reachable only via explicit selection (status-bar Advanced group / settings),
 * so a quick key-repeat can never silently escalate a session into
 * `bypassPermissions`.
 */
export const SAFE_CYCLE_MODES = [
  "default",
  "acceptEdits",
  "plan",
] as const satisfies readonly PermissionMode[]

/** Modes deliberately kept OUT of the quick cycle (explicit selection only). */
export const ADVANCED_MODES: readonly PermissionMode[] = PERMISSION_MODES.filter(
  (m) => !(SAFE_CYCLE_MODES as readonly PermissionMode[]).includes(m)
)

/** The metadata for a mode, falling back to a minimal safe entry for unknowns. */
export function permissionModeMeta(mode: PermissionMode): PermissionModeMeta {
  return (
    PERMISSION_MODE_META[mode] ?? {
      risk: "safe",
      tone: "text-muted-foreground",
      i18nKey: "default",
    }
  )
}

/**
 * A `⚠` marker for danger modes, `•` for elevated, empty for safe — for chips,
 * menus, and settings badges.
 */
export function permissionRiskMarker(mode: PermissionMode): string {
  const risk = permissionModeMeta(mode).risk
  return risk === "danger" ? "⚠" : risk === "elevated" ? "•" : ""
}

/**
 * The next safe-core permission mode after `current`, wrapping past the last.
 *
 * The composer represents "inherit the character/app default" as `null`; that
 * shares the cycle slot with the `default` mode, so this returns `null` when it
 * lands there (keeping the per-session override cleared) and never returns a
 * concrete `"default"`. When `current` is a power mode (not in the cycle) it
 * drops back to the default slot — an intentional de-escalation, never a jump
 * into another power mode.
 */
export function cyclePermissionMode(current: PermissionMode | null): PermissionMode | null {
  const cur: PermissionMode = current ?? "default"
  const i = SAFE_CYCLE_MODES.indexOf(cur as (typeof SAFE_CYCLE_MODES)[number])
  const next = SAFE_CYCLE_MODES[(i + 1) % SAFE_CYCLE_MODES.length]
  return next === "default" ? null : next
}
