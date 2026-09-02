"use client"

/**
 * Security tab of the account detail pane. Two concerns, clearly separated:
 * - "This account's password" — per-account change-password (selected account).
 * - "Session security" — the global idle auto-lock interval (shared
 *   `AutoLockControl`) and an immediate "Lock now", enabled only while a
 *   session is unlocked.
 */

import { useState, type FormEvent } from "react"
import { useTranslations } from "next-intl"
import { LockKeyholeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { AutoLockControl } from "@/components/settings/security/auto-lock-control"
import { PASSWORD_MIN_LENGTH } from "@/lib/accounts/password-policy"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { useAccountStore } from "@/stores/account/account-store"

import { PasswordStrengthMeter } from "../password-strength-meter"
import { QuickUnlockSettings } from "../quick-unlock/quick-unlock-settings"

export interface AccountSecurityTabProps {
  account: LocalAccountRecord
}

export function AccountSecurityTab({ account }: AccountSecurityTabProps) {
  const t = useTranslations("account.manage")
  const changePassword = useAccountStore((state) => state.changePassword)
  const lock = useAccountStore((state) => state.lock)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const enrollQuickUnlockMethod = useAccountStore((state) => state.enrollQuickUnlockMethod)
  const removeQuickUnlockMethod = useAccountStore((state) => state.removeQuickUnlockMethod)
  const clearQuickUnlockLockout = useAccountStore((state) => state.clearQuickUnlockLockout)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setChanged(false)
    if (next.length < PASSWORD_MIN_LENGTH) {
      setError(t("passwordTooShort", { min: PASSWORD_MIN_LENGTH }))
      return
    }
    if (next !== confirm) {
      setError(t("passwordMismatch"))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await changePassword(account.id, current, next)
      setCurrent("")
      setNext("")
      setConfirm("")
      setChanged(true)
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="account-security-tab">
      <form
        className="flex flex-col gap-2"
        aria-label={t("changePasswordHeading")}
        onSubmit={(event) => void submit(event)}
      >
        <p className="text-sm font-medium">{t("changePasswordHeading")}</p>
        <Label htmlFor="account-current-password">{t("currentPasswordLabel")}</Label>
        <Input
          id="account-current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          placeholder={t("currentPasswordPlaceholder")}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <Label htmlFor="account-change-new-password">{t("changeNewPasswordLabel")}</Label>
        <Input
          id="account-change-new-password"
          type="password"
          autoComplete="new-password"
          value={next}
          placeholder={t("changeNewPasswordPlaceholder")}
          onChange={(event) => setNext(event.target.value)}
        />
        <PasswordStrengthMeter password={next} />
        <Label htmlFor="account-confirm-new-password">{t("confirmNewPasswordLabel")}</Label>
        <Input
          id="account-confirm-new-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          placeholder={t("confirmNewPasswordPlaceholder")}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {changed && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("passwordChanged")}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={submitting}>
          {t("changePassword")}
        </Button>
      </form>

      <Separator />

      {/* Quick unlock sits between the password and the session controls,
          because it is a way IN rather than a way to end a session. */}
      <QuickUnlockSettings
        account={account}
        onEnroll={enrollQuickUnlockMethod}
        onRemove={removeQuickUnlockMethod}
        onClearLockout={clearQuickUnlockLockout}
      />

      <Separator />

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("sessionSecurityHeading")}</p>
        <AutoLockControl />
        <div className="flex items-center justify-between gap-2 rounded-lg border p-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium">{t("lockNowLabel")}</p>
            <p className="text-[11px] text-muted-foreground">{t("lockNowHelp")}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            disabled={!unlockedAccountId}
            onClick={() =>
              void Promise.resolve(lock()).catch((cause) =>
                setError(toErrorMessage(cause, t("operationFailed")))
              )
            }
            data-testid="account-security-lock-now"
          >
            <LockKeyholeIcon className="size-3.5" />
            {t("lockNow")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

export default AccountSecurityTab
