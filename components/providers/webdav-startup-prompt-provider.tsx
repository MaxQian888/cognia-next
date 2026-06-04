"use client"

// Surfaces "the WebDAV server holds a snapshot newer than this device" as a
// unified-notification-center entry (ADR-0042) — on startup AND whenever the
// app resumes to the foreground or the network comes back. The notification's
// href routes to the restore UI (/settings?section=data on desktop,
// /me/backup on mobile); restore itself stays explicit.
//
// Double-fire safety: `checkRemoteNewerThanLocal` dedupes per remote snapshot
// via `webdavSync.lastRemoteSeenAt`, and the notification carries a
// `dedupeKey` — so this provider and the backup scheduler's 30-minute tick
// can both call `notifyIfRemoteNewer` without spamming.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { subscribeResume } from "@/lib/capacitor/app"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"
import { notifyIfRemoteNewer } from "@/lib/webdav/remote-newer-notify"

/** Trailing debounce so resume+online bursts collapse into one check. */
const RECHECK_DEBOUNCE_MS = 5_000

export function WebDavStartupPromptProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("settings.data.webdav.startup")
  const ranRef = useRef(false)

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return
    if (typeof window === "undefined") return
    if (ranRef.current) return
    ranRef.current = true

    let disposed = false
    let timer: number | null = null
    const strings = { title: t("newerFound"), body: t("newerBody") }

    const check = () => {
      void notifyIfRemoteNewer(strings)
    }
    const debouncedCheck = () => {
      if (disposed) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(check, RECHECK_DEBOUNCE_MS)
    }

    // Boot check (immediate — no debounce needed).
    check()

    const unsubs: Array<() => void> = []
    void subscribeResume(debouncedCheck).then((u) => {
      if (disposed) u()
      else unsubs.push(u)
    })
    void subscribeNetwork((status) => {
      if (status.connected) debouncedCheck()
    }).then((u) => {
      if (disposed) u()
      else unsubs.push(u)
    })

    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      for (const u of unsubs) u()
    }
  }, [t])

  return <>{children}</>
}
