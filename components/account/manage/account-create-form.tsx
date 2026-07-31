"use client"

/**
 * Collapsed-by-default "create local account" form for the manage dialog list
 * column. Kept out of the always-open layout so the account list is the primary
 * surface; expands inline on demand. Reuses `PasswordStrengthMeter` and the
 * shared `PASSWORD_MIN_LENGTH` policy.
 */

import { useState, type FormEvent } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PASSWORD_MIN_LENGTH } from "@/lib/accounts/password-policy"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { useAccountStore } from "@/stores/account/account-store"

import { PasswordStrengthMeter } from "../password-strength-meter"

export interface AccountCreateFormProps {
  onCreated?: (account: LocalAccountRecord) => void
}

export function AccountCreateForm({ onCreated }: AccountCreateFormProps) {
  const t = useTranslations("account.manage")
  const createAccount = useAccountStore((state) => state.createAccount)
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const close = () => {
    setOpen(false)
    setDisplayName("")
    setPassword("")
    setError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t("passwordTooShort", { min: PASSWORD_MIN_LENGTH }))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const account = await createAccount({ displayName, password })
      close()
      onCreated?.(account)
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full gap-2"
        onClick={() => setOpen(true)}
        data-testid="account-create-toggle"
      >
        <PlusIcon className="size-4" />
        {t("newAccount")}
      </Button>
    )
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-md border p-3"
      aria-label={t("createHeading")}
      onSubmit={(event) => void submit(event)}
    >
      <p className="text-sm font-medium">{t("createHeading")}</p>
      <Label htmlFor="account-new-display-name">{t("newDisplayNameLabel")}</Label>
      <Input
        id="account-new-display-name"
        value={displayName}
        placeholder={t("newDisplayNamePlaceholder")}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <Label htmlFor="account-new-password">{t("newPasswordLabel")}</Label>
      <Input
        id="account-new-password"
        type="password"
        autoComplete="new-password"
        value={password}
        placeholder={t("newPasswordPlaceholder")}
        onChange={(event) => setPassword(event.target.value)}
      />
      <PasswordStrengthMeter password={password} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={close} disabled={submitting}>
          {t("cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting} className="gap-2">
          <PlusIcon className="size-4" />
          {t("createAccount")}
        </Button>
      </div>
    </form>
  )
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

export default AccountCreateForm
