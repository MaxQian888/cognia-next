"use client"

/**
 * Shared switch/unlock-with-password flow for local accounts. Extracted so the
 * rail `AccountSwitcher` popover and the manage dialog's detail header drive the
 * exact same behaviour instead of duplicating password handling:
 *
 * - switching to the active account is a no-op,
 * - switching to an already-unlocked (this-session) account is passwordless,
 * - otherwise a password prompt is opened and verified via the store.
 *
 * The hook owns only transient prompt state; the store owns the real work
 * (`switchAccount` verifies the password and re-points the account database).
 */

import { useState } from "react"

import { useAccountStore } from "@/stores/account/account-store"

export interface AccountSwitchController {
  /** The account id awaiting a password (null → no pending prompt). */
  pendingId: string | null
  password: string
  setPassword: (value: string) => void
  error: string | null
  submitting: boolean
  /**
   * Begin switching to `accountId`. Resolves `true` when the switch completed
   * synchronously (active → no-op, or unlocked → passwordless); resolves
   * `false` when a password prompt was opened (`pendingId` set).
   */
  begin: (accountId: string) => Promise<boolean>
  /** Confirm the pending switch using the entered password. */
  confirm: () => Promise<boolean>
  /** Dismiss the password prompt and reset transient state. */
  cancel: () => void
}

export interface UseAccountSwitchOptions {
  /** Called after a successful switch/unlock with the target account id. */
  onSwitched?: (accountId: string) => void
  /** Fallback message shown for non-Error throwables. */
  operationFailedLabel?: string
}

export function useAccountSwitch(options: UseAccountSwitchOptions = {}): AccountSwitchController {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const switchAccount = useAccountStore((state) => state.switchAccount)

  const [pendingId, setPendingId] = useState<string | null>(null)
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    setPendingId(null)
    setPassword("")
    setError(null)
  }

  const finish = async (accountId: string, pw?: string): Promise<boolean> => {
    setSubmitting(true)
    setError(null)
    try {
      await switchAccount(accountId, pw)
      reset()
      options.onSwitched?.(accountId)
      return true
    } catch (err) {
      setError(toMessage(err, options.operationFailedLabel))
      return false
    } finally {
      setSubmitting(false)
    }
  }

  const begin = async (accountId: string): Promise<boolean> => {
    setError(null)
    setPassword("")
    if (accountId === activeAccountId) {
      setPendingId(null)
      return true
    }
    if (accountId === unlockedAccountId) {
      // Verified earlier this session → activate without re-prompting.
      return finish(accountId)
    }
    setPendingId(accountId)
    return false
  }

  const confirm = async (): Promise<boolean> => {
    if (!pendingId) return false
    return finish(pendingId, password)
  }

  return { pendingId, password, setPassword, error, submitting, begin, confirm, cancel: reset }
}

function toMessage(error: unknown, fallback = "Local account operation failed."): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}
