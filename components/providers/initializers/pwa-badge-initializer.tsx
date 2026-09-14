"use client"

import { useEffect } from "react"
import Dexie from "dexie"

import { loadMobileUnread } from "@/lib/inbox/unread-count"
import { applyAppBadge } from "@/lib/pwa/app-badge"
import { isStandaloneDisplayMode } from "@/lib/pwa/install-state"
import { detectPlatform } from "@/lib/platform/detect"

/**
 * Keeps the installed PWA's dock/taskbar icon badged with the unread chat
 * count (`navigator.setAppBadge`). Reads the same `sessionState` source as
 * the mobile badges (`loadMobileUnread`), so the icon number and the in-app
 * badges can never drift.
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
    let subscription: { unsubscribe: () => void } | null = null

    const start = () => {
      if (subscription) return
      // `Dexie.liveQuery`, not the named `liveQuery` export: the latter is
      // undefined under Jest's module interop.
      subscription = Dexie.liveQuery(() => loadMobileUnread()).subscribe({
        next: (counts) => applyAppBadge(counts.chat),
        error: () => {},
      })
    }
    const stop = () => {
      subscription?.unsubscribe()
      subscription = null
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
