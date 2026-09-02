"use client"

/**
 * Danger-zone tab: delete the selected local account. Guards preserved — the
 * last account can't be deleted, and deleting the active account hands
 * activation to a replacement (the first other account).
 *
 * Two safety nets before the irreversible store teardown (`deleteAccount`
 * drops the account's Dexie database, so it cannot be undone once it runs):
 *   1. Strong confirm — the user must type the account's exact name.
 *   2. Short undo window — on confirm we do NOT delete immediately; we show an
 *      undo toast plus an inline affordance and only run `deleteAccount` after
 *      UNDO_WINDOW_MS. The timer is intentionally detached from the React
 *      lifecycle so it still commits if the dialog closes; Undo cancels it and
 *      nothing is destroyed.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon, Undo2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import type { ProfileCloudIdentityStep } from "@/lib/identity/forget-profile-identity"
import { useAccountStore } from "@/stores/account/account-store"

const UNDO_WINDOW_MS = 8000

/** Machine step names → label keys under `account.manage.cloudIdentityStep`. */
const CLOUD_IDENTITY_STEP_KEY: Record<ProfileCloudIdentityStep, string> = {
  session: "session",
  binding: "binding",
  "collab-connection": "collabConnection",
  "host-person": "hostPerson",
}

export interface AccountDangerTabProps {
  account: LocalAccountRecord
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
}

type Phase = "idle" | "confirming" | "scheduled"

export function AccountDangerTab({ account, accounts, activeAccountId }: AccountDangerTabProps) {
  const t = useTranslations("account.manage")
  const deleteAccount = useAccountStore((state) => state.deleteAccount)
  const [phase, setPhase] = useState<Phase>("idle")
  const [typed, setTyped] = useState("")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastRef = useRef<string | number | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const replacementAccountId =
    account.id === activeAccountId
      ? accounts.find((candidate) => candidate.id !== account.id)?.id
      : undefined
  const isLast = accounts.length <= 1
  const canDelete = !isLast && (account.id !== activeAccountId || Boolean(replacementAccountId))
  const nameMatches = typed.trim() === account.displayName.trim()

  const cancelTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (toastRef.current !== null) {
      toast.dismiss(toastRef.current)
      toastRef.current = null
    }
  }

  const undo = () => {
    cancelTimer()
    if (mountedRef.current) {
      setPhase("idle")
      setTyped("")
    }
  }

  const commit = () => {
    // Detached from the component lifecycle — runs even if the dialog closed.
    timerRef.current = null
    toastRef.current = null
    void deleteAccount(account.id, { replacementAccountId })
      .then((result) => {
        // The profile is gone either way. What must not be reported as a
        // clean delete is a cloud sign-in the app could not fully clear.
        const cleanup = result.cloudIdentity
        if (cleanup.failures.length > 0) {
          toast.warning(
            t("deleteCloudIdentityIncomplete", {
              steps: cleanup.failures
                .map((failure) => t(`cloudIdentityStep.${CLOUD_IDENTITY_STEP_KEY[failure.step]}`))
                .join(", "),
            })
          )
        }
        if (cleanup.tokensMayRemainLive) {
          toast.warning(t("deleteTokensMayRemainLive"))
        }
      })
      .catch((err) => {
        toast.error(toErrorMessage(err, t("operationFailed")))
      })
  }

  const schedule = () => {
    if (!canDelete || !nameMatches) return
    cancelTimer()
    setPhase("scheduled")
    timerRef.current = setTimeout(commit, UNDO_WINDOW_MS)
    toastRef.current = toast(t("deleteScheduledToast", { name: account.displayName }), {
      duration: UNDO_WINDOW_MS,
      action: { label: t("undo"), onClick: undo },
    })
  }

  return (
    <div className="flex flex-col gap-3" data-testid="account-danger-tab">
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-sm font-medium text-destructive">{t("deleteHeading")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {isLast ? t("deleteBlockedLast") : t("deleteHelp")}
        </p>

        {phase === "scheduled" ? (
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("deleteScheduledInline")}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-2"
              onClick={undo}
              data-testid="account-danger-undo"
            >
              <Undo2Icon className="size-4" />
              {t("undo")}
            </Button>
          </div>
        ) : phase === "confirming" ? (
          <div className="mt-3 flex flex-col gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="account-danger-confirm-input">
              {t("deleteConfirmPrompt", { name: account.displayName })}
            </label>
            <Input
              id="account-danger-confirm-input"
              value={typed}
              placeholder={t("deleteConfirmPlaceholder")}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              data-testid="account-danger-confirm-input"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="gap-2"
                disabled={!canDelete || !nameMatches}
                onClick={schedule}
                data-testid="account-danger-delete"
              >
                <Trash2Icon className="size-4" />
                {t("confirmDelete")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={undo}>
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 gap-2"
            disabled={!canDelete}
            onClick={() => setPhase("confirming")}
            data-testid="account-danger-delete"
          >
            <Trash2Icon className="size-4" />
            {t("delete")}
          </Button>
        )}
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
