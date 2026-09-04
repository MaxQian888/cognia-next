"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import {
  inspectProviderAccountReferences,
  type ProviderAccountReferences,
} from "@/lib/subscription/core/account-lifecycle"
import type { AccountSummary, ProviderId } from "@/types/subscription"

export function RenameDialog({
  account,
  onClose,
  onSubmit,
}: {
  account: AccountSummary
  onClose: () => void
  onSubmit: (label: string | null) => Promise<void>
}) {
  const t = useTranslations("subscription.common.accountList")
  const [value, setValue] = useState(account.label ?? "")
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("renameDialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-label">{t("renameLabel")}</Label>
          <Input
            id="rename-label"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t("renamePlaceholder")}
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">{t("renameClearHint")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={async () => {
              setBusy(true)
              try {
                await onSubmit(value.trim() || null)
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy}
          >
            {busy && <Spinner className="mr-2 size-4" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RemoveDialog({
  provider,
  account,
  accounts,
  onClose,
  onConfirm,
}: {
  provider: ProviderId
  account: AccountSummary
  accounts: AccountSummary[]
  onClose: () => void
  onConfirm: (replacementAccountId: string | null) => Promise<void>
}) {
  const t = useTranslations("subscription.common.accountList")
  const [busy, setBusy] = useState(false)
  const [loadingReferences, setLoadingReferences] = useState(true)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [references, setReferences] = useState<ProviderAccountReferences | null>(null)
  const [replacementAccountId, setReplacementAccountId] = useState("")
  const remainingAccounts = useMemo(
    () => accounts.filter((candidate) => candidate.id !== account.id),
    [account.id, accounts]
  )
  const hasReferences =
    !!references &&
    (references.sessions.length > 0 ||
      references.characters.length > 0 ||
      references.isDefault ||
      references.isActive)
  const requiresReplacement = remainingAccounts.length > 0 && hasReferences

  const loadReferences = useCallback(async () => {
    setLoadingReferences(true)
    setReferenceError(null)
    try {
      const next = await inspectProviderAccountReferences(provider, account.id)
      setReferences(next)
      const referenced =
        next.sessions.length > 0 || next.characters.length > 0 || next.isDefault || next.isActive
      if (remainingAccounts.length > 0 && referenced) {
        setReplacementAccountId(remainingAccounts[0].id)
      }
    } catch (cause) {
      setReferenceError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingReferences(false)
    }
  }, [account.id, provider, remainingAccounts])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadReferences()
    })
    return () => {
      cancelled = true
    }
  }, [loadReferences])

  const isDiscovered = account.variant === "opencode-discovered"
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(isDiscovered ? "unlinkDialogTitle" : "removeDialogTitle")}</DialogTitle>
          <DialogDescription>
            {account.label || account.email || account.id.slice(0, 8)}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(isDiscovered ? "unlinkDialogBody" : "removeDialogBody")}
        </p>
        {loadingReferences && (
          <p className="text-xs text-muted-foreground">
            <Spinner className="mr-2 inline size-3" />
            {t("checkingReferences")}
          </p>
        )}
        {referenceError && (
          <div className="space-y-2 text-xs text-destructive">
            <p>{referenceError}</p>
            <Button size="sm" variant="outline" onClick={() => void loadReferences()}>
              {t("retry")}
            </Button>
          </div>
        )}
        {references && hasReferences && (
          <div className="space-y-2 rounded-md border p-3 text-xs">
            <p>
              {t("referenceSummary", {
                sessions: references.sessions.length,
                characters: references.characters.length,
              })}
            </p>
            {references.isActive && <p>{t("activeReference")}</p>}
            {references.isDefault && <p>{t("defaultReference")}</p>}
            {[
              ...references.sessions.map((item) => item.title),
              ...references.characters.map((item) => item.name),
            ].filter(Boolean).length > 0 && (
              <p className="text-muted-foreground">
                {t("referenceNames", {
                  names: [
                    ...references.sessions.map((item) => item.title),
                    ...references.characters.map((item) => item.name),
                  ]
                    .filter(Boolean)
                    .join(", "),
                })}
              </p>
            )}
            {requiresReplacement ? (
              <div className="space-y-1">
                <Label htmlFor="account-replacement">{t("replacementLabel")}</Label>
                <NativeSelect
                  id="account-replacement"
                  aria-label={t("replacementLabel")}
                  className="w-full"
                  value={replacementAccountId}
                  onChange={(event) => setReplacementAccountId(event.target.value)}
                >
                  {remainingAccounts.map((candidate) => (
                    <NativeSelectOption key={candidate.id} value={candidate.id}>
                      {candidate.label || candidate.email || candidate.id.slice(0, 8)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            ) : remainingAccounts.length === 0 ? (
              <p className="text-muted-foreground">{t("finalAccountReferencesCleared")}</p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(requiresReplacement ? replacementAccountId : null)
              } finally {
                setBusy(false)
              }
            }}
            disabled={
              busy ||
              loadingReferences ||
              !!referenceError ||
              (requiresReplacement && !replacementAccountId)
            }
          >
            {busy && <Spinner className="mr-2 size-4" />}
            {t(isDiscovered ? "unlinkConfirm" : "removeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
