"use client"

/**
 * Danger-zone tab: delete the selected local account. Preserves the existing
 * guards — the last account can't be deleted, and deleting the active account
 * hands activation to a replacement (the first other account). Two-step confirm
 * before the destructive store call.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { useAccountStore } from "@/stores/account/account-store"

export interface AccountDangerTabProps {
  account: LocalAccountRecord
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
}

export function AccountDangerTab({ account, accounts, activeAccountId }: AccountDangerTabProps) {
  const t = useTranslations("account.manage")
  const deleteAccount = useAccountStore((state) => state.deleteAccount)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const replacementAccountId =
    account.id === activeAccountId
      ? accounts.find((candidate) => candidate.id !== account.id)?.id
      : undefined
  const isLast = accounts.length <= 1
  const canDelete = !isLast && (account.id !== activeAccountId || Boolean(replacementAccountId))

  const remove = async () => {
    if (!canDelete) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await deleteAccount(account.id, { replacementAccountId })
      setConfirming(false)
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="account-danger-tab">
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-sm font-medium text-destructive">{t("deleteHeading")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {isLast ? t("deleteBlockedLast") : t("deleteHelp")}
        </p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          type="button"
          variant={confirming ? "destructive" : "outline"}
          size="sm"
          className="mt-3 gap-2"
          disabled={!canDelete || submitting}
          onClick={() => void remove()}
          data-testid="account-danger-delete"
        >
          <Trash2Icon className="size-4" />
          {confirming ? t("confirmDelete") : t("delete")}
        </Button>
      </div>
    </div>
  )
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

export default AccountDangerTab
