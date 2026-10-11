/**
 * Where each glance owner surface lives in the main window (ADR-0225 §1).
 *
 * Two owners are not routes. Agent Fleet on the desktop is the island window,
 * focused on a row through `island://focus-row`; the notification center is
 * the status bar's popover, opened through its request seam. Both have a
 * route fallback here for when that surface is not mounted, so a click always
 * lands somewhere real.
 */

import { settingsHref } from "@/lib/settings/deep-link"

import type { GlanceOwnerSurface } from "./registry"

/** The scheduler page selects an item by its unified id. */
export function schedulerHref(itemId?: string): string {
  return itemId ? `/scheduler?item=${encodeURIComponent(itemId)}` : "/scheduler"
}

/** The route an owner surface opens at. */
export function glanceOwnerHref(owner: GlanceOwnerSurface, itemId?: string): string {
  switch (owner) {
    case "usage":
      return settingsHref("subscription", { params: { subTab: "usage" } })
    case "subscription":
      return settingsHref("subscription")
    case "scheduler":
      return schedulerHref(itemId)
    case "notifications":
      return settingsHref("notifications")
    case "connectivity":
      return settingsHref("connectivity")
    case "conversations":
      return "/conversations"
    case "pet":
      return "/pet"
    case "tray-actions":
      return settingsHref("desktop")
    case "fleet":
      // The desktop's Fleet is the island; when it cannot be opened, the run
      // history is the nearest page that lists the same work.
      return "/agent-runs"
  }
}
