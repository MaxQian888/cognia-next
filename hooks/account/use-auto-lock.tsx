"use client"

/**
 * Idle auto-lock. When the user has set a non-zero `accountAutoLockMinutes`
 * (Settings → Account → Security) and an account is currently unlocked, lock
 * it after that many minutes without user activity.
 *
 * Correctness note — this uses a wall-clock deadline, not an accumulating
 * `setTimeout`. A backgrounded or throttled tab may never fire its timer on
 * schedule; on every visibility/focus regain we recompute against
 * `Date.now()` and lock immediately if the idle window has already elapsed.
 * Activity handlers only stamp a timestamp (cheap even under `pointermove`);
 * the single armed timer re-arms for the remainder when it finds fresh
 * activity, so continuous use never churns timers.
 *
 * Mounted once by <AccountGate> (desktop-only; web/mobile have no password
 * gate, and with the default 0-minute setting the hook is inert anyway).
 */

import { useEffect, useRef } from "react"

import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings"

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "pointermove", "wheel", "touchstart"] as const

export function useAutoLock(): void {
  const minutes = useSettingsStore((s) => s.settings?.accountAutoLockMinutes ?? 0)
  const locked = useAccountStore((s) => s.locked)
  const lastActivityRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (minutes <= 0 || locked) return

    const windowMs = minutes * 60_000

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const arm = () => {
      clearTimer()
      const remaining = windowMs - (Date.now() - lastActivityRef.current)
      if (remaining <= 0) {
        useAccountStore.getState().lock()
        return
      }
      timerRef.current = setTimeout(onExpire, remaining)
    }

    const onExpire = () => {
      timerRef.current = null
      // Fresh activity since we armed? Wait out the remainder instead of locking.
      const remaining = windowMs - (Date.now() - lastActivityRef.current)
      if (remaining <= 0) {
        useAccountStore.getState().lock()
      } else {
        arm()
      }
    }

    const bump = () => {
      lastActivityRef.current = Date.now()
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") arm()
    }

    lastActivityRef.current = Date.now()
    arm()

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, bump, { passive: true })
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onVisibility)

    return () => {
      clearTimer()
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, bump)
      }
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onVisibility)
    }
  }, [minutes, locked])
}
