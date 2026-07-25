/**
 * Pure permission-mode cycling for the Shift+Tab affordance (Claude Code
 * parity): each Shift+Tab advances to the next mode in `CYCLE_MODES`
 * (default → acceptEdits → plan → bypassPermissions), wrapping at the end.
 *
 * Bypass is the last rung rather than being excluded: landing on it does not
 * apply it, it opens the acknowledgement confirm (see
 * `runtime/permission-mode-switch.ts`), and an open overlay swallows further
 * Shift+Tabs — so a key-repeat still cannot escalate silently. The remaining
 * power modes (`dontAsk` / `auto`) stay out of the cycle and are chosen
 * explicitly via the `/mode` overlay. Kept pure so the App's key handler is a
 * one-liner and the wrap-around unit-tests without rendering.
 */
import type { PermissionMode } from "../state/types"
import { CYCLE_MODES } from "../state/permission-mode-meta"

/** The next cycled permission mode after `current`, wrapping past the last.
 * When `current` is an off-cycle power mode (`dontAsk` / `auto`), Shift+Tab
 * drops back to the first safe mode — an intentional de-escalation. */
export function cyclePermissionMode(current: PermissionMode): PermissionMode {
  const i = CYCLE_MODES.indexOf(current)
  // -1 (current is an off-cycle mode or unknown) → start at the first safe mode.
  return CYCLE_MODES[(i + 1) % CYCLE_MODES.length]
}
