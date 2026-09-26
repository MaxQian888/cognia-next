"use client"

import { useEffect } from "react"

import { getUnreadSessionsSnapshot, subscribeUnreadSessions } from "@/lib/chat/unread-sessions"
import { countMobileUnread } from "@/lib/inbox/unread-count"
import { applyAppBadge } from "@/lib/pwa/app-badge"
import { isStandaloneDisplayMode } from "@/lib/pwa/install-state"
import { detectPlatform } from "@/lib/platform/detect"

/**
 * Keeps the installed PWA's dock/taskbar icon badged with the unread chat
 * count (`navigator.setAppBadge`). Subscribes to the window's one unread read
 * (`lib/chat/unread-sessions.ts`) and counts it the way the mobile badges do
 * (`countMobileUnread`), so the icon number and the in-app badges can never
 * drift, and the icon costs no Dexie observer of its own.
 *
 * Web-only, and only while `display-mode: standalone` — the badge API paints
 * the installed icon, which a plain browser tab never has. Subscribing to
 * the media query also covers install-mid-session: the moment Chrome flips
 * the window to standalone the subscription starts.
 */
export function PwaBadgeInitializer() {
  useEffect(() => {
    if (detectPlatform() !== "web") return
    if (typeof window.matchMedia !== "function") return

    const media = window.matchMedia("(display-mode: standalone)")
    let unsubscribe: (() => void) | null = null

    // Paints only once a read has landed: a cold store says "unknown", and
    // clearing the icon on "unknown" would blink it at every start.
    const paint = () => {
      const unread = getUnreadSessionsSnapshot()
      if (!unread) return
      applyAppBadge(countMobileUnread(unread.sessions, unread.unreadBySession).chat)
    }
    const start = () => {
      if (unsubscribe) return
      unsubscribe = subscribeUnreadSessions(paint)
      // The store may already be warm (the shell's badges subscribed first),
      // in which case no change is coming to trigger the first paint.
      paint()
    }
    const stop = () => {
      unsubscribe?.()
      unsubscribe = null
    }
    const syncToMode = () => (isStandaloneDisplayMode() ? start() : stop())

    syncToMode()
    media.addEventListener("change", syncToMode)
    return () => {
      media.removeEventListener("change", syncToMode)
      stop()
    }
  }, [])

  return null
}

export default PwaBadgeInitializer
