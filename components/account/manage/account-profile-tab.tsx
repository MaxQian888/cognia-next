"use client"

/**
 * Profile tab of the account detail pane: per-account avatar (reusing the
 * shared `ProfileAvatarPicker` + its crop/downscale pipeline), display-name
 * rename, and created/updated metadata. Presentational apart from the two store
 * actions it drives; the parent keys it by `account.id` so drafts reset when the
 * selection changes (no set-state-in-effect).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { ProfileAvatarPicker } from "@/components/settings/profile/profile-avatar-picker"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { useAccountStore } from "@/stores/account/account-store"

import { formatAccountDate } from "./format-account-date"

export interface AccountProfileTabProps {
  account: LocalAccountRecord
}

export function AccountProfileTab({ account }: AccountProfileTabProps) {
  const t = useTranslations("account.manage")
  const renameAccount = useAccountStore((state) => state.renameAccount)
  const setAccountAvatar = useAccountStore((state) => state.setAccountAvatar)
  // Draft-or-stored: null means "not editing — show the stored name".
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const name = nameDraft ?? account.displayName

  const save = async () => {
    if (nameDraft === null) return
    const next = nameDraft.trim()
    if (!next || next === account.displayName) {
      setNameDraft(null)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await renameAccount(account.id, next)
      setNameDraft(null)
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    } finally {
      setSubmitting(false)
    }
  }

  const changeAvatar = async (dataUrl: string | null) => {
    setError(null)
    try {
      await setAccountAvatar(account.id, dataUrl)
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="account-profile-tab">
      <div className="flex flex-col gap-2">
        <Label>{t("avatarHeading")}</Label>
        <ProfileAvatarPicker
          value={account.avatarDataUrl ?? null}
          fallbackName={account.displayName}
          onChange={changeAvatar}
          disabled={submitting}
        />
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <Label htmlFor="account-edit-display-name">{t("editDisplayNameLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="account-edit-display-name"
            value={name}
            onChange={(event) => setNameDraft(event.target.value)}
          />
          <Button type="button" size="sm" disabled={submitting} onClick={() => void save()}>
            {t("save")}
          </Button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Separator />

      <dl
        className="grid grid-cols-2 gap-2 text-xs text-muted-foreground"
        data-testid="account-metadata"
      >
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium text-foreground/70">{t("createdAtLabel")}</dt>
          <dd>{formatAccountDate(account.createdAt)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium text-foreground/70">{t("updatedAtLabel")}</dt>
          <dd>{formatAccountDate(account.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  )
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

export default AccountProfileTab
