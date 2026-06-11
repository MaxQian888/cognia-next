// Tray "Launch at login" toggle plumbing. The tray item fires the
// `toggle-autostart` native action; Rust re-emits `tray://toggle-autostart`,
// which `hooks/system/use-tauri-events.ts` routes to `toggleTrayAutostart()`.
//
// After flipping the OS-level autostart entry we broadcast a DOM event so the
// tray state snapshot (`lib/tray/state-snapshot.ts`) can refresh the checkbox
// without polling. Kept in its own module — decoupled from both the event
// hook and the snapshot hook, and trivially unit-testable.

import { isAutostartEnabled, setAutostart } from "@/lib/tauri/autostart"

/** DOM event broadcast after the autostart entry is toggled. `detail` is the new on/off value. */
export const AUTOSTART_CHANGED_EVENT = "cognia:tray-autostart-changed"

/**
 * Flip the OS launch-at-login entry and broadcast the resulting state.
 * Returns the value read back from the platform after the write (the source
 * of truth), so callers reflect what actually took effect rather than the
 * value they intended.
 */
export async function toggleTrayAutostart(): Promise<boolean> {
  const current = await isAutostartEnabled()
  await setAutostart(!current)
  const next = await isAutostartEnabled()
  broadcastAutostartChanged(next)
  return next
}

/** Emit the change event. No-op outside a DOM (SSR / node tests without jsdom). */
export function broadcastAutostartChanged(on: boolean): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return
  window.dispatchEvent(new CustomEvent(AUTOSTART_CHANGED_EVENT, { detail: on }))
}

/**
 * Subscribe to autostart-change broadcasts. Returns an unsubscribe function.
 * No-op (returns a noop unsubscribe) outside a DOM.
 */
export function onAutostartChanged(cb: (on: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const handler = (e: Event) => cb(Boolean((e as CustomEvent<boolean>).detail))
  window.addEventListener(AUTOSTART_CHANGED_EVENT, handler)
  return () => window.removeEventListener(AUTOSTART_CHANGED_EVENT, handler)
}
