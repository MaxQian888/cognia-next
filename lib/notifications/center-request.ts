/**
 * Ask the notification center to open, from anywhere in the main window.
 *
 * The center is the status bar bell's popover and owns its own open state.
 * Another surface (the tray panel's agenda line, ADR-0225) routing a click to
 * it needs to know whether anything is there to open: the bell is not mounted
 * when the user removed it from their status bar. So unlike a fire-and-forget
 * DOM event, `requestNotificationCenter` reports whether a host heard it, and
 * the caller falls back to the notifications settings page when none did.
 */

export const NOTIFICATION_CENTER_REQUEST_EVENT = "cognia:notification-center:request"

let hosts = 0

/** Returns true when a mounted host received the request. */
export function requestNotificationCenter(): boolean {
  if (typeof window === "undefined" || hosts === 0) return false
  window.dispatchEvent(new CustomEvent(NOTIFICATION_CENTER_REQUEST_EVENT))
  return true
}

/** Register a host (the bell). Returns the unregister. */
export function onNotificationCenterRequest(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = () => handler()
  window.addEventListener(NOTIFICATION_CENTER_REQUEST_EVENT, listener)
  hosts += 1
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    hosts -= 1
    window.removeEventListener(NOTIFICATION_CENTER_REQUEST_EVENT, listener)
  }
}
