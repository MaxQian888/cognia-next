"use client"

// Capacitor-only: opportunistically uploads an encrypted snapshot to WebDAV
// when the app resumes to the foreground or the network comes back — phones
// don't run the desktop's 30-minute backup scheduler, so without this the
// mobile copy of the data never reaches the server unattended.
//
// All gating (sync enabled, passphrase available — incl. opt-in keyring
// hydration —, dirty check, 5-minute floor) lives in
// `lib/webdav/auto-upload.ts:maybeAutoUploadNow`; this provider only owns the
// platform gate and the event → debounce wiring. No-op on web/Tauri/test.

import { useEffect, useRef } from "react"

import { getDevicePlatform } from "@/components/mobile/pair/pair-helpers"
import { subscribeResume } from "@/lib/capacitor/app"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"
import { maybeAutoUploadNow } from "@/lib/webdav/auto-upload"

/** Trailing debounce: resume + online often fire together. */
const TRIGGER_DEBOUNCE_MS = 5_000

export function WebDavMobileAutosyncProvider({ children }: { children: React.ReactNode }) {
  const ranRef = useRef(false)

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return
    if (typeof window === "undefined") return
    if (ranRef.current) return
    ranRef.current = true

    const platform = getDevicePlatform()
    if (platform !== "ios" && platform !== "android") return

    let disposed = false
    let timer: number | null = null

    const trigger = () => {
      if (disposed) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void maybeAutoUploadNow()
      }, TRIGGER_DEBOUNCE_MS)
    }

    // Boot attempt (debounced — boot races the keyring/auto-key injection).
    trigger()

    const unsubs: Array<() => void> = []
    void subscribeResume(trigger).then((u) => {
      if (disposed) u()
      else unsubs.push(u)
    })
    void subscribeNetwork((status) => {
      if (status.connected) trigger()
    }).then((u) => {
      if (disposed) u()
      else unsubs.push(u)
    })

    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      for (const u of unsubs) u()
    }
  }, [])

  return <>{children}</>
}
