// Tray "Launch at login" toggle plumbing. The tray item fires the
// `toggle-autostart` native action; Rust re-emits `tray://toggle-autostart`,
// which `hooks/system/use-tauri-events.ts` routes to `toggleTrayAutostart()`.
//
// After flipping the OS-level autostart entry we broadcast a DOM event so the
// tray state snapshot (`lib/tray/state-snapshot.ts`) can refresh the checkbox
// without polling. Kept in its own module — decoupled from both the event
// hook and the snapshot hook, and trivially unit-testable.

import { toggleAutostart } from "@/lib/tauri/autostart"

// Keep existing consumers on the same event while settings, host-mode and tray
// writes all publish through the native wrapper.
export {
  AUTOSTART_CHANGED_EVENT,
  broadcastAutostartChanged,
  onAutostartChanged,
} from "@/lib/tauri/autostart"

/**
 * Flip the OS launch-at-login entry and broadcast the resulting state.
 * Returns the value read back from the platform after the write (the source
 * of truth), so callers reflect what actually took effect rather than the
 * value they intended.
 */
export async function toggleTrayAutostart(): Promise<boolean> {
  return toggleAutostart()
}
