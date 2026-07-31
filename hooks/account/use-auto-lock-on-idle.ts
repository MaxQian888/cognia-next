"use client"

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings"

// Reset the idle timer on deliberate interaction. We intentionally avoid
// `pointermove`/`mousemove` — a single key press or click is enough signal and
// keeps timer churn negligible (no throttle needed).
const RESET_EVENTS = ["pointerdown", "keydown"] as const

/**
 * Auto-lock the active local account after a configurable idle period.
 *
 * No-op unless running under Tauri (local accounts are desktop-only), an
 * account is unlocked, and `accountAutoLockMinutes > 0`. On timeout it calls
 * the account store's `lock()`, which flips the AccountGate back to the unlock
 * screen. While the window is hidden the timer keeps counting, so backgrounding
 * the app still locks it on schedule.
 */
export function useAutoLockOnIdle(): void {
  const autoLockMinutes = useSettingsStore((s) => s.settings?.accountAutoLockMinutes ?? 0)
  const unlockedAccountId = useAccountStore((s) => s.unlockedAccountId)

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!isTauri()) return
    if (!unlockedAccountId) return
    if (!autoLockMinutes || autoLockMinutes <= 0) return

    const timeoutMs = autoLockMinutes * 60_000
    let timer: ReturnType<typeof setTimeout> | undefined

    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        useAccountStore.getState().lock()
      }, timeoutMs)
    }

    const onActivity = () => {
      // While hidden, don't reset — let the timer run down toward a lock.
      if (document.visibilityState === "hidden") return
      arm()
    }

    arm()
    for (const event of RESET_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true })
    }
    document.addEventListener("visibilitychange", onActivity)

    return () => {
      if (timer) clearTimeout(timer)
      for (const event of RESET_EVENTS) {
        window.removeEventListener(event, onActivity)
      }
      document.removeEventListener("visibilitychange", onActivity)
    }
  }, [autoLockMinutes, unlockedAccountId])
}
