"use client"

/**
 * Idle auto-lock for the active local account. THE implementation — there used
 * to be two.
 *
 * `useAutoLock` (called from inside `AccountGate`) and `useAutoLockOnIdle`
 * (mounted as `<AccountAutoLock/>`) both read `accountAutoLockMinutes` and both
 * called `lock()`, so on the desktop two independent timers raced. They did not
 * agree: one refused to lock while a turn was streaming, the other had no such
 * guard — so the guard was defeated and the app could lock in the middle of a
 * run. This is the merge of the two, with the stronger behaviour from each.
 *
 * Correctness notes:
 *
 * - **Wall-clock deadline, not an accumulating `setTimeout`.** A backgrounded or
 *   throttled tab may never fire its timer on schedule; on every visibility or
 *   focus regain we recompute against `Date.now()` and lock immediately if the
 *   idle window has already elapsed. Activity handlers only stamp a timestamp
 *   (cheap even under `pointermove`), and the single armed timer re-arms for the
 *   remainder when it finds fresh activity, so continuous use never churns
 *   timers.
 *
 * - **Bounded run deferral.** A streaming or approval-waiting local turn may
 *   delay the first idle deadline by one additional lock window. At the second
 *   deadline the turn is interrupted and the account locks; background work
 *   can never keep the DEK resident forever.
 *
 * - **Not on overlay windows.** The desktop pet / fleet-island windows load the
 *   same layout and pass straight through `AccountGate`, so they would each run
 *   their own timer — and they never see the pointer and key events happening in
 *   the main window. Left ungated, an overlay window would lock the whole app
 *   out from under someone actively working in it.
 *
 * - **Not desktop-only.** The earlier `isTauri()` gate was wrong: an ordinary
 *   browser has a real local account backed by the Browser Vault, and locking it
 *   is exactly as meaningful there.
 *
 * Inert until the user sets a non-zero timeout in Settings → Account → Security.
 */

import { useEffect, useRef } from "react"

import { interruptSession } from "@/lib/claude/ipc"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import { useAccountStore } from "@/stores/account/account-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "pointermove", "wheel", "touchstart"] as const

export function useAutoLockOnIdle(): void {
  const minutes = useSettingsStore((s) => s.settings?.accountAutoLockMinutes ?? 0)
  const unlockedAccountId = useAccountStore((s) => s.unlockedAccountId)
  const lastActivityRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typeof window === "undefined") return
    if (minutes <= 0 || !unlockedAccountId) return
    if (isSecondaryOverlayRole(getPetWindowRole())) return

    const windowMs = minutes * 60_000

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const blockingSessionIds = () =>
      Object.entries(useChatStore.getState().sessions)
        .filter(
          ([, session]) => session.status === "streaming" || session.status === "awaiting_approval"
        )
        .map(([sessionId]) => sessionId)

    const lockNow = (sessionIds: string[] = []) => {
      if (sessionIds.length === 0) {
        void Promise.resolve(useAccountStore.getState().lock()).catch(() => undefined)
        return
      }
      void Promise.allSettled(sessionIds.map((sessionId) => interruptSession(sessionId)))
        .then(() => useAccountStore.getState().lock())
        .catch(() => undefined)
    }

    const arm = () => {
      clearTimer()
      const remaining = windowMs - (Date.now() - lastActivityRef.current)
      if (remaining <= 0) {
        lockNow()
        return
      }
      timerRef.current = setTimeout(onExpire, remaining)
    }

    const onExpire = () => {
      timerRef.current = null
      // Fresh activity since we armed? Wait out the remainder instead of locking.
      const idleFor = Date.now() - lastActivityRef.current
      const remaining = windowMs - idleFor
      if (remaining > 0) {
        arm()
        return
      }

      const blockers = blockingSessionIds()
      const maximumDeferralRemaining = windowMs * 2 - idleFor
      if (blockers.length > 0 && maximumDeferralRemaining > 0) {
        timerRef.current = setTimeout(onExpire, maximumDeferralRemaining)
        return
      }
      lockNow(blockers)
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
  }, [minutes, unlockedAccountId])
}
