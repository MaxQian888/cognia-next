"use client"

import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { useEffect } from "react"

const log = loggers.ui

const ATTR = "data-window-focused"

/**
 * Headless component that mirrors the Tauri window's focus state onto
 * `<html data-window-focused="true|false">`. The value drives the `[data-app-chrome]`
 * dim rule in `globals.css` so the title-bar / status-bar / resize-edges visually
 * recede when the window blurs (matching VSCode).
 *
 * In web mode the component does nothing and renders nothing.
 */
export function WindowFocusTracker() {
  useEffect(() => {
    if (typeof document === "undefined") return
    if (!isTauri()) {
      // Web mode: chrome is always considered "focused" so it doesn't dim.
      document.documentElement.setAttribute(ATTR, "true")
      return
    }

    let unlisten: (() => void) | undefined
    let cancelled = false

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const win = getCurrentWindow()
        // Seed with the current focus state so the first paint is correct.
        const focused = await win.isFocused()
        if (cancelled) return
        document.documentElement.setAttribute(ATTR, focused ? "true" : "false")
        const dispose = await win.onFocusChanged(({ payload }) => {
          document.documentElement.setAttribute(ATTR, payload ? "true" : "false")
        })
        // Unmounted while the registration was in flight (StrictMode's
        // mount→unmount→mount): release it now or it leaks for the session.
        if (cancelled) {
          safeUnlisten(dispose)
          return
        }
        unlisten = dispose
      } catch (err) {
        log.warn("focus-tracker setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()

    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [])

  return null
}
