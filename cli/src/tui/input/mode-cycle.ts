/**
 * Pure permission-mode cycling for the Shift+Tab affordance (Claude Code
 * parity): each Shift+Tab advances to the next mode in the SAFE CORE
 * (`SAFE_CYCLE_MODES` = default → acceptEdits → plan), wrapping at the end. The
 * power modes (`bypassPermissions` / `dontAsk` / `auto`) are deliberately NOT in
 * the cycle — a key-repeat must never silently escalate a session into a
 * no-guardrail mode; they are chosen explicitly via the `/mode` overlay. Kept
 * pure so the App's key handler is a one-liner and the wrap-around unit-tests
 * without rendering.
 */
import type { PermissionMode } from "../state/types"
import { SAFE_CYCLE_MODES } from "../state/permission-mode-meta"

/** The next safe-core permission mode after `current`, wrapping past the last.
 * When `current` is a power mode (not in the cycle), Shift+Tab drops back to the
 * first safe mode — an intentional de-escalation, never a jump into another
 * power mode. */
export function cyclePermissionMode(current: PermissionMode): PermissionMode {
  const i = SAFE_CYCLE_MODES.indexOf(current)
  // -1 (current is a power mode or unknown) → start at the first safe mode.
  return SAFE_CYCLE_MODES[(i + 1) % SAFE_CYCLE_MODES.length]
}
