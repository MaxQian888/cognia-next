/**
 * Pure permission-mode cycling for the Shift+Tab affordance (Claude Code
 * parity): each Shift+Tab advances to the next mode in `PERMISSION_MODES`,
 * wrapping at the end. Kept pure so the App's key handler is a one-liner and the
 * wrap-around is unit-tested without rendering.
 */
import { PERMISSION_MODES } from "../../config/schema"
import type { PermissionMode } from "../state/types"

/** The next permission mode after `current`, wrapping past the last. */
export function cyclePermissionMode(current: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(current)
  // -1 (unknown current) → start at the first mode.
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]
}
