"use client"

// Shared multi-account list with one-click switch + rename + delete. Reused
// by the Claude / Codex / OpenCode provider tabs.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, MoreVerticalIcon, RadioIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { useAccounts } from "@/lib/subscription/core/hooks"
import {
  inspectProviderAccountReferences,
  setProviderDefaultAccount,
  type ProviderAccountReferences,
} from "@/lib/subscription/core/account-lifecycle"
import { accountExpiryState } from "@/lib/subscription/core/account-expiry"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { Account, AccountSummary, ProviderId } from "@/types/subscription"

import { AccountUsageChips, useAccountUsageIndex } from "./account-usage-chips"
import { AccountPresetSelector, providerSupportsPresets } from "./account-preset-selector"

interface AccountListProps {
  provider: ProviderId
  onAdd?: () => void
  /**
   * Custom secondary action surfaced as a single ghost button next to "Add
   * account" (e.g. "Adopt discovered" for OpenCode).
   */
  secondaryAction?: React.ReactNode
  onUpdate?: (account: Account) => void
}

export function AccountList({ provider, onAdd, secondaryAction, onUpdate }: AccountListProps) {
  const t = useTranslations("subscription.common.accountList")
  const {
    accounts,
    activeAccountId,
    loading,
    error,
    pendingAccountId,
    reload,
    setActive,
    rename,
    remove,
    fetchFull,
  } = useAccounts(provider)
  const settings = useSettingsStore((state) => state.settings)
  const defaultAccountId =
    settings?.defaultAccountIds?.[provider] ??
    (settings?.defaultProvider === provider ? settings.defaultAccountId : undefined)
  // Queried once for the whole list — see `useAccountUsageIndex`.
  const usageIndex = useAccountUsageIndex()
  // Shared ticker, so the expiry read-out doesn't go stale while the pane is open.
  const now = useSubscriptionNow()

  const [renameTarget, setRenameTarget] = useState<AccountSummary | null>(null)
  const [removeTarget, setRemoveTarget] = useState<AccountSummary | null>(null)

  const reportFailure = useCallback(
    (cause: unknown) => {
      toast.error(
        t("actionFailed", { error: cause instanceof Error ? cause.message : String(cause) })
      )
    },
    [t]
  )

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t("title")}</Label>
          <div className="flex items-center gap-2">
            {secondaryAction}
            {onAdd && (
              <Button size="sm" onClick={onAdd}>
                {t("addAccount")}
              </Button>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-center justify-between gap-2 text-xs text-destructive">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void reload().catch(reportFailure)}>
              {t("retry")}
            </Button>
          </div>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 inline size-3 animate-spin" />…
          </p>
        ) : accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center gap-2 rounded border bg-card/40 px-2.5 py-1.5 text-sm"
              >
                <button
                  type="button"
                  aria-label={t("setActive")}
                  className={`flex size-5 items-center justify-center rounded-full border ${
                    account.id === activeAccountId
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-muted-foreground/40 text-muted-foreground"
                  }`}
                  onClick={() =>
                    void setActive(account.id)
                      .then(() => toast.success(t("activated")))
                      .catch(reportFailure)
                  }
                  disabled={account.id === activeAccountId}
                >
                  <RadioIcon className="size-3" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {account.label || account.email || account.id.slice(0, 8)}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {[account.email, account.plan].filter(Boolean).join(" · ")}
                  </div>
                  <AccountExpiryLine expiresAtMs={account.expiresAtMs} nowMs={now} />
                  <AccountUsageChips accountId={account.id} usage={usageIndex.get(account.id)} />
                  {providerSupportsPresets(provider) && (
                    <AccountPresetSelector provider={provider} accountId={account.id} />
                  )}
                </div>
                {account.id === activeAccountId && (
                  <Badge variant="default" className="text-[10px]">
                    {t("active")}
                  </Badge>
                )}
                {account.id === defaultAccountId && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("default")}
                  </Badge>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7">
                      <MoreVerticalIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {onUpdate && (
                      <DropdownMenuItem
                        onSelect={() => {
                          void fetchFull(account.id)
                            .then((full) => {
                              if (!full) throw new Error(t("accountMissing"))
                              onUpdate(full)
                            })
                            .catch(reportFailure)
                        }}
                      >
                        {t("updateCredentials")}
                      </DropdownMenuItem>
                    )}
                    {account.id !== defaultAccountId && (
                      <DropdownMenuItem
                        onSelect={() =>
                          void setProviderDefaultAccount(provider, account.id)
                            .then(() => toast.success(t("defaultSet")))
                            .catch(reportFailure)
                        }
                      >
                        {t("setDefault")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setRenameTarget(account)} disabled={loading}>
                      {t("rename")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setRemoveTarget(account)}
                      className="text-destructive focus:text-destructive"
                      disabled={pendingAccountId === account.id}
                    >
                      {account.variant === "opencode-discovered" ? t("unlink") : t("remove")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {renameTarget && (
        <RenameDialog
          account={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (label) => {
            try {
              await rename(renameTarget.id, label)
              toast.success(t("renamed"))
              setRenameTarget(null)
            } catch (cause) {
              reportFailure(cause)
            }
          }}
        />
      )}
      {removeTarget && (
        <RemoveDialog
          provider={provider}
          account={removeTarget}
          accounts={accounts}
          onClose={() => setRemoveTarget(null)}
          onConfirm={async (replacementAccountId) => {
            try {
              await remove(removeTarget.id, replacementAccountId)
              toast.success(t("removed"))
              setRemoveTarget(null)
            } catch (cause) {
              reportFailure(cause)
            }
          }}
        />
      )}
    </Card>
  )
}

/**
 * Per-row credential expiry. Previously invisible everywhere in the list — only
 * the *active* account's expiry showed, one panel over in the Account tab — so
 * a user with several saved accounts had no read-out at all.
 *
 * Says "refreshes on next use" rather than "expired": `expiresAtMs` is the
 * access token's expiry and an elapsed one is routine (see `account-expiry.ts`).
 * Refresh failures aren't persisted in the vault, so there is nothing here that
 * could honestly claim an account is broken.
 */
function AccountExpiryLine({ expiresAtMs, nowMs }: { expiresAtMs: number; nowMs: number }) {
  const t = useTranslations("subscription.common.accountList")
  const state = accountExpiryState(expiresAtMs, nowMs)
  if (state === "notApplicable") return null

  return (
    <div
      className={`truncate text-[11px] ${state === "stale" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}
      data-testid="account-expiry"
      data-state={state}
    >
      {state === "stale"
        ? t("expiryStale")
        : t("expiryValid", { at: new Date(expiresAtMs).toLocaleString() })}
    </div>
  )
}

function RenameDialog({
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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("renameDialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-label">{t("renameLabel")}</Label>
          <Input
            id="rename-label"
            value={value}
            onChange={(e) => setValue(e.target.value)}
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
                await onSubmit(value.trim() ? value.trim() : null)
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy}
          >
            {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RemoveDialog({
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
  // A "discovered" OpenCode row is only a pointer to an external auth.json —
  // removing it unlinks the pointer and never touches that file. Say so.
  const isDiscovered = account.variant === "opencode-discovered"
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
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
            <Loader2Icon className="mr-2 inline size-3 animate-spin" />
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
            {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t(isDiscovered ? "unlinkConfirm" : "removeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
