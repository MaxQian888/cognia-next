"use client"

/**
 * Turns on the desktop half of the Browser Companion's agent mode and status
 * hints (ADR-0228 §4–6), once, for the life of the app:
 *
 * - conversations a browser started in agent mode are bound back to that
 *   browser, so their browser tools keep acting there after a restart, and
 *   unbound while the Owner has revoked that browser's `browser.drive`;
 * - a paired browser is hinted on its device socket when one of its
 *   submissions changes state, so its badge and notifications are prompt.
 *
 * Only the desktop shell can reach a browser's device socket, so nothing is
 * wired elsewhere. Renders nothing; mounted once in
 * `components/runtime/app-runtime.tsx`.
 */

import { useEffect } from "react"

import { startBrowserCompanionAgentRuntime } from "@/lib/browser-companion/host-dispatch"
import { isTauri } from "@/lib/tauri"

export function BrowserCompanionAgentInitializer() {
  useEffect(() => {
    if (!isTauri()) return
    let stop: (() => void) | null = null
    let cancelled = false
    void startBrowserCompanionAgentRuntime()
      .then((teardown) => {
        if (cancelled) teardown()
        else stop = teardown
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
  return null
}

export default BrowserCompanionAgentInitializer
