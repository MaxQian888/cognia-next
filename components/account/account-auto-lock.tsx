"use client"

import { useAutoLockOnIdle } from "@/hooks/account/use-auto-lock-on-idle"

/**
 * The single mount point for the idle auto-lock timer. `AccountGate` used to
 * call a second, divergent copy of this hook directly; there is now one hook and
 * one mount.
 *
 * Self-gates (unlocked account + a positive timeout + not an overlay window + no
 * running local turn) inside the hook, so it is safe to mount unconditionally.
 */
export function AccountAutoLock() {
  useAutoLockOnIdle()
  return null
}

export default AccountAutoLock
