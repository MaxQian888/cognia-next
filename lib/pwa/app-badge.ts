/**
 * App-icon badging for the installed PWA (`navigator.setAppBadge`).
 *
 * Only meaningful in a standalone PWA window: the badge paints on the
 * dock/taskbar/home-screen icon, which a browser tab never has. Everything
 * here is a no-op outside that context — Chromium-only API, so every call
 * is feature-detected rather than platform-sniffed.
 */

import { isStandaloneDisplayMode } from "./install-state"

export function isAppBadgeSupported(): boolean {
  if (typeof window === "undefined") return false
  // lib.dom types setAppBadge on Navigator, but the API is Chromium-only —
  // feature-detect, never trust the type.
  return typeof window.navigator.setAppBadge === "function"
}

/**
 * Paint (or clear) the unread dot on the installed icon. Returns whether a
 * badge call was actually made — `false` when the API is missing or this is
 * not an installed window, so callers can distinguish "cleared" from "n/a".
 */
export function applyAppBadge(unreadCount: number): boolean {
  if (!isAppBadgeSupported() || !isStandaloneDisplayMode()) return false
  if (unreadCount > 0) {
    void window.navigator.setAppBadge(unreadCount).catch(() => {})
  } else {
    void window.navigator.clearAppBadge().catch(() => {})
  }
  return true
}
