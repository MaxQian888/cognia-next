"use client"

import { useAutoLockOnIdle } from "@/hooks/account/use-auto-lock-on-idle"

/**
 * Headless mount point for the idle auto-lock timer. Self-gates (Tauri +
 * unlocked account + a positive timeout) inside the hook, so it's safe to mount
 * unconditionally at the top of the app tree.
 */
export function AccountAutoLock() {
  useAutoLockOnIdle()
  return null
}

export default AccountAutoLock
