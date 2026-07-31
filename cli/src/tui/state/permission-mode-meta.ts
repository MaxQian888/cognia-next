/**
 * Single-source metadata for the permission modes — the human label, a one-line
 * "what runs without asking" summary, and a risk tier. Mirrors the exhaustive-
 * record pattern (`Record<PermissionMode, …>`) so a newly added mode is a
 * compile error until it is described here, and every surface (the `/mode`
 * overlay, the Shift+Tab notice, the footer segment) reads the SAME copy instead
 * of hand-maintaining three drifting tables.
 */
import { PERMISSION_MODES } from "../../config/schema"
import type { PermissionMode } from "./types"

/** How much a mode relaxes the approval gate. Drives the warning marker. */
export type PermissionRisk = "safe" | "elevated" | "danger"

export interface PermissionModeMeta {
  /** Short human label shown in menus (may differ from the enum id). */
  label: string
  /** One-line summary of what the mode lets run without a prompt. */
  runsWithoutAsking: string
  risk: PermissionRisk
}

export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  default: {
    label: "default",
    runsWithoutAsking: "Reads run freely; you're asked before every edit or command.",
    risk: "safe",
  },
  acceptEdits: {
    label: "accept edits",
    runsWithoutAsking: "Reads and file edits run without asking; other commands still prompt.",
    risk: "elevated",
  },
  plan: {
    label: "plan",
    runsWithoutAsking: "Read-only — research and propose a plan; no edits are made.",
    risk: "safe",
  },
  auto: {
    label: "auto",
    runsWithoutAsking: "Runs most actions with minimal prompting.",
    risk: "elevated",
  },
  dontAsk: {
    label: "don't ask",
    runsWithoutAsking: "Only pre-approved and read-only tools run; anything else is denied.",
    risk: "elevated",
  },
  bypassPermissions: {
    label: "bypass",
    runsWithoutAsking: "Everything runs without asking — no permission guardrails.",
    risk: "danger",
  },
}

/** The modes that need no acknowledgement — they keep a real approval gate. */
export const SAFE_CYCLE_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan"]

/**
 * The modes the Shift+Tab affordance cycles through: the safe core, then
 * `bypassPermissions` as the last rung.
 *
 * Bypass used to be kept out of the cycle entirely so a key-repeat could not
 * silently escalate a session into a no-guardrail mode. That guarantee now comes
 * from a different place — every transition INTO a danger-tier mode opens the
 * acknowledgement confirm (see `runtime/permission-mode-switch.ts`), and an open
 * overlay swallows further Shift+Tabs — so the cycle can carry it without the
 * escalation being silent.
 */
export const CYCLE_MODES: readonly PermissionMode[] = [...SAFE_CYCLE_MODES, "bypassPermissions"]

/** Modes deliberately kept OUT of the Shift+Tab cycle (explicit selection only). */
export const ADVANCED_MODES: readonly PermissionMode[] = PERMISSION_MODES.filter(
  (m) => !CYCLE_MODES.includes(m)
)

/**
 * Does entering `mode` require an explicit acknowledgement first?
 *
 * Sourced from the shared risk model rather than a hardcoded id, so a future
 * danger-tier mode is gated by the same confirm without editing the call sites.
 */
export function requiresAcknowledgement(mode: PermissionMode): boolean {
  return permissionModeMeta(mode).risk === "danger"
}

/** The metadata for a mode, falling back to a minimal safe entry for unknowns. */
export function permissionModeMeta(mode: PermissionMode): PermissionModeMeta {
  return PERMISSION_MODE_META[mode] ?? { label: mode, runsWithoutAsking: "", risk: "safe" }
}

/** A `⚠ ` marker for elevated/danger modes, empty for safe ones — for menus/notices. */
export function permissionRiskMarker(mode: PermissionMode): string {
  const risk = permissionModeMeta(mode).risk
  return risk === "danger" ? "⚠ " : risk === "elevated" ? "• " : ""
}
