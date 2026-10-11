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

/** A workflow's runs page, or the runs list without one. */
export function workflowRunsHref(workflowId?: string): string {
  return workflowId ? `/workflows/runs?id=${encodeURIComponent(workflowId)}` : "/workflows/runs"
}

/** The route an owner surface opens at. */
export function glanceOwnerHref(owner: GlanceOwnerSurface, itemId?: string): string {
  switch (owner) {
    case "workflows":
      return workflowRunsHref(itemId)
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

/**
 * The route an owner surface opens at on a phone. The phone has its own homes
 * for several owners: Agent Fleet is the `/fleet` page (where the phone's own
 * approvals live), usage and quota sit under Me › Subscription, notifications
 * under Me › Notifications, connectivity on the devices page.
 *
 * `tray-actions` returns null: on a phone the quick module's owner is the
 * layout editor's shortcut list, a sheet rather than a page, so the caller
 * opens that instead.
 */
export function glanceMobileOwnerHref(owner: GlanceOwnerSurface, itemId?: string): string | null {
  switch (owner) {
    case "fleet":
      return "/fleet"
    case "workflows":
      return workflowRunsHref(itemId)
    case "usage":
      return "/me/subscription?subTab=usage"
    case "subscription":
      return "/me/subscription"
    case "scheduler":
      return schedulerHref(itemId)
    case "notifications":
      return "/me/notifications"
    case "connectivity":
      return "/devices"
    case "conversations":
      return "/conversations"
    case "pet":
      return "/pet"
    case "tray-actions":
      return null
  }
}
