"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { SettingsAlert } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  accountCapabilities,
  providerDisplayOrder,
} from "@/lib/subscription/core/account-capabilities"
import { setProviderDefaultAccount } from "@/lib/subscription/core/account-lifecycle"
import { useAccounts, type UseAccountsResult } from "@/lib/subscription/core/hooks"
import { getAccountDetail } from "@/lib/subscription/core/transport"
import { isTauri } from "@/lib/tauri"
import { useElementWidth } from "@/hooks/use-element-width"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { AccountDetail, AccountSummary, ProviderId } from "@/types/subscription"

import { AccountPresetSelector } from "./account-preset-selector"
import { AccountUsageChips, useAccountUsageIndex, type AccountUsage } from "./account-usage-chips"
import { RemoveDialog, RenameDialog } from "./account-dialogs"
import { AnthropicAddAccountDialog } from "./add-account-dialog/anthropic"
import { CodexAddAccountDialog, type CodexLoginMode } from "./add-account-dialog/codex"
import { OpencodeAddAccountDialog } from "./add-account-dialog/opencode"

type ProviderFilter = "all" | ProviderId

interface DialogState {
  provider: ProviderId
  account?: AccountSummary
  codexMode?: CodexLoginMode
}

export function AccountCenter() {
  const t = useTranslations("subscription.accountCenter")
  const accountCenterRef = useRef<HTMLDivElement>(null)
  const accountCenterWidth = useElementWidth(accountCenterRef)
  const stackedDetail = accountCenterWidth < 680
  const anthropic = useAccounts("anthropic")
  const codex = useAccounts("codex")
  const opencode = useAccounts("opencode")
  const usageIndex = useAccountUsageIndex()
  const settings = useSettingsStore((state) => state.settings)
  const [filter, setFilter] = useState<ProviderFilter>("all")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailResult, setDetailResult] = useState<{
    key: string
    value: AccountDetail | null
  } | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [renameTarget, setRenameTarget] = useState<AccountSummary | null>(null)
  const [removeTarget, setRemoveTarget] = useState<AccountSummary | null>(null)

  const states = useMemo(() => ({ anthropic, codex, opencode }), [anthropic, codex, opencode])
  const accounts = useMemo(
    () =>
      Object.values(states)
        .flatMap((state) => state.accounts)
        .filter((account) => filter === "all" || account.provider === filter)
        .sort(
          (left, right) =>
            providerDisplayOrder(left.provider) - providerDisplayOrder(right.provider) ||
            right.lastUsedAtMs - left.lastUsedAtMs
        ),
    [filter, states]
  )
  const selected = accounts.find((account) => accountKey(account) === selectedKey) ?? accounts[0]
  const selectedState = selected ? states[selected.provider] : null
  const selectedAccountKey = selected ? accountKey(selected) : null
  const detail = detailResult?.key === selectedAccountKey ? detailResult.value : null
  const detailLoading = !!selectedAccountKey && detailResult?.key !== selectedAccountKey
  const activeAccountId = selectedState?.activeAccountId ?? null
  const defaultAccountId = selected
    ? (settings?.defaultAccountIds?.[selected.provider] ??
      (settings?.defaultProvider === selected.provider ? settings.defaultAccountId : undefined))
    : undefined

  useEffect(() => {
    if (!selected || !selectedAccountKey) return
    let alive = true
    void getAccountDetail(selected.provider, selected.id)
      .then((value) => {
        if (alive) setDetailResult({ key: selectedAccountKey, value })
      })
      .catch(() => {
        if (alive) setDetailResult({ key: selectedAccountKey, value: null })
      })
    return () => {
      alive = false
    }
  }, [selected, selectedAccountKey])

  if (!isTauri()) {
    return <SettingsAlert title={t("title")}>{t("webMode")}</SettingsAlert>
  }

  const openAccount = (account: AccountSummary) => {
    setSelectedKey(accountKey(account))
    if (stackedDetail) setMobileDetailOpen(true)
  }

  return (
    <div
      ref={accountCenterRef}
      className="@container/account-center space-y-4"
      data-testid="account-center"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="text-sm">{t("title")}</Label>
          <p className="max-w-2xl text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="shrink-0">
              <PlusIcon className="mr-1.5 size-4" />
              {t("add")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(["anthropic", "codex", "opencode"] as const).map((provider) => (
              <DropdownMenuItem key={provider} onSelect={() => setDialog({ provider })}>
                {t(`providers.${provider}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("filterLabel")}>
        {(["all", "anthropic", "codex", "opencode"] as const).map((provider) => (
          <Button
            key={provider}
            size="sm"
            variant={filter === provider ? "secondary" : "ghost"}
            onClick={() => setFilter(provider)}
            data-testid={`account-filter-${provider}`}
          >
            {provider === "all" ? t("filters.all") : t(`providers.${provider}`)}
          </Button>
        ))}
      </div>

      <div className="grid min-h-[360px] gap-3 @[680px]/account-center:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.2fr)]">
        <Card className="min-w-0">
          <CardContent className="p-2">
            {Object.values(states).some((state) => state.loading) && accounts.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                <Loader2Icon className="mr-2 inline size-3 animate-spin" />
                {t("loading")}
              </p>
            ) : accounts.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">{t("empty")}</p>
            ) : (
              <ul className="space-y-1" aria-label={t("listLabel")}>
                {accounts.map((account) => {
                  const state = states[account.provider]
                  const defaultId =
                    settings?.defaultAccountIds?.[account.provider] ??
                    (settings?.defaultProvider === account.provider
                      ? settings.defaultAccountId
                      : undefined)
                  return (
                    <li key={accountKey(account)}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left hover:bg-muted/40 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/5"
                        data-active={
                          selected?.id === account.id && selected.provider === account.provider
                        }
                        data-testid={`account-center-row-${account.provider}-${account.id}`}
                        onClick={() => openAccount(account)}
                      >
                        <HealthIcon health={account.health} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1">
                            <span className="truncate text-sm font-medium">
                              {accountName(account)}
                            </span>
                            {state.activeAccountId === account.id && (
                              <Badge className="text-[10px]">{t("badges.active")}</Badge>
                            )}
                            {defaultId === account.id && (
                              <Badge variant="secondary" className="text-[10px]">
                                {t("badges.default")}
                              </Badge>
                            )}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {t(`providers.${account.provider}`)} · {account.authMode} ·{" "}
                            {account.credentialSource}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="hidden min-w-0 @[680px]/account-center:block">
          {selected && selectedState ? (
            <AccountDetailPanel
              account={selected}
              detail={detail}
              detailLoading={detailLoading}
              state={selectedState}
              active={activeAccountId === selected.id}
              isDefault={defaultAccountId === selected.id}
              usage={usageIndex.get(selected.id)}
              onEdit={(mode) =>
                setDialog({ provider: selected.provider, account: selected, codexMode: mode })
              }
              onRename={() => setRenameTarget(selected)}
              onRemove={() => setRemoveTarget(selected)}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </div>

      <Sheet open={mobileDetailOpen} onOpenChange={setMobileDetailOpen}>
        <SheetContent side="right" className="w-[min(92vw,440px)] overflow-y-auto p-4">
          <SheetHeader>
            <SheetTitle>{selected ? accountName(selected) : t("title")}</SheetTitle>
          </SheetHeader>
          {selected && selectedState && (
            <AccountDetailPanel
              account={selected}
              detail={detail}
              detailLoading={detailLoading}
              state={selectedState}
              active={activeAccountId === selected.id}
              isDefault={defaultAccountId === selected.id}
              usage={usageIndex.get(selected.id)}
              onEdit={(mode) =>
                setDialog({ provider: selected.provider, account: selected, codexMode: mode })
              }
              onRename={() => setRenameTarget(selected)}
              onRemove={() => setRemoveTarget(selected)}
            />
          )}
        </SheetContent>
      </Sheet>

      <AccountDialog state={dialog} onClose={() => setDialog(null)} />

      {renameTarget && (
        <RenameDialog
          account={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (label) => {
            await states[renameTarget.provider].rename(renameTarget.id, label)
            setRenameTarget(null)
            toast.success(t("actions.renamed"))
          }}
        />
      )}
      {removeTarget && (
        <RemoveDialog
          provider={removeTarget.provider}
          account={removeTarget}
          accounts={states[removeTarget.provider].accounts}
          onClose={() => setRemoveTarget(null)}
          onConfirm={async (replacementId) => {
            await states[removeTarget.provider].remove(removeTarget.id, replacementId)
            setRemoveTarget(null)
            setMobileDetailOpen(false)
            toast.success(t("actions.removed"))
          }}
        />
      )}
    </div>
  )
}

function AccountDetailPanel({
  account,
  detail,
  detailLoading,
  state,
  active,
  isDefault,
  usage,
  onEdit,
  onRename,
  onRemove,
}: {
  account: AccountSummary
  detail: AccountDetail | null
  detailLoading: boolean
  state: UseAccountsResult
  active: boolean
  isDefault: boolean
  usage: AccountUsage | undefined
  onEdit: (mode?: CodexLoginMode) => void
  onRename: () => void
  onRemove: () => void
}) {
  const t = useTranslations("subscription.accountCenter")
  const capabilities = accountCapabilities(account)
  const [actionPending, setActionPending] = useState(false)
  const runAction = async (operation: () => Promise<unknown>) => {
    setActionPending(true)
    try {
      await operation()
    } catch (cause) {
      toast.error(
        t("actions.failed", { error: cause instanceof Error ? cause.message : String(cause) })
      )
    } finally {
      setActionPending(false)
    }
  }
  return (
    <Card className="min-w-0" data-testid="account-center-detail">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="truncate text-base">{accountName(account)}</Label>
              <Badge variant={healthBadgeVariant(account.health)}>
                {t(`health.${account.health}`)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(`providers.${account.provider}`)} · {account.authMode} · {account.credentialSource}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t("actions.more")}>
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {capabilities.rename && (
                <DropdownMenuItem onSelect={onRename}>{t("actions.rename")}</DropdownMenuItem>
              )}
              {capabilities.updateCredential && (
                <DropdownMenuItem onSelect={() => onEdit()}>{t("actions.update")}</DropdownMenuItem>
              )}
              {capabilities.reauthenticate && (
                <DropdownMenuItem onSelect={() => onEdit("oauth")}>
                  <RefreshCwIcon className="mr-2 size-4" />
                  {t("actions.reauthenticate")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {capabilities.removeLocal && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={onRemove}
                >
                  {t("actions.removeLocal")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <Info label={t("fields.active")} value={active ? t("yes") : t("no")} />
          <Info label={t("fields.default")} value={isDefault ? t("yes") : t("no")} />
          <Info label={t("fields.source")} value={account.credentialSource} />
          <Info label={t("fields.authMode")} value={account.authMode} />
          <Info
            label={t("fields.expiry")}
            value={
              account.expiresAtMs > 0
                ? new Date(account.expiresAtMs).toLocaleString()
                : t("fields.notApplicable")
            }
          />
          {account.email && <Info label={t("fields.email")} value={account.email} />}
          {account.plan && <Info label={t("fields.plan")} value={account.plan} />}
        </div>

        <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          <p>{t("activeHelp")}</p>
          <p className="mt-1">{t("defaultHelp")}</p>
        </div>

        {account.reauthReason && (
          <SettingsAlert title={t("health.reauth_required")}>
            {t("reauthReason", { reason: account.reauthReason })}
          </SettingsAlert>
        )}

        <AccountUsageChips accountId={account.id} usage={usage} />
        {capabilities.bindPreset && (
          <AccountPresetSelector provider={account.provider} accountId={account.id} />
        )}

        {detailLoading ? (
          <p className="text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 inline size-3 animate-spin" />
            {t("loadingDetail")}
          </p>
        ) : detail?.lastCredentialRotationAtMs ? (
          <Info
            label={t("fields.lastRotation")}
            value={new Date(detail.lastCredentialRotationAtMs).toLocaleString()}
          />
        ) : null}

        <div className="flex flex-wrap gap-2">
          {active
            ? capabilities.deactivate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runAction(() => state.setActive(null))}
                  disabled={actionPending}
                >
                  {t("actions.deactivate")}
                </Button>
              )
            : capabilities.activate && (
                <Button
                  size="sm"
                  onClick={() => void runAction(() => state.setActive(account.id))}
                  disabled={actionPending}
                >
                  {t("actions.activate")}
                </Button>
              )}
          {!isDefault && capabilities.setDefault && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void runAction(() => setProviderDefaultAccount(account.provider, account.id))
              }
              disabled={actionPending}
            >
              {t("actions.setDefault")}
            </Button>
          )}
          {actionPending && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
        </div>
      </CardContent>
    </Card>
  )
}

function AccountDialog({ state, onClose }: { state: DialogState | null; onClose: () => void }) {
  if (!state) return null
  const common = {
    open: true,
    onOpenChange: (open: boolean) => !open && onClose(),
    existingAccount: state.account,
    onAdded: onClose,
    onUpdated: onClose,
  }
  switch (state.provider) {
    case "anthropic":
      return <AnthropicAddAccountDialog {...common} />
    case "codex":
      return <CodexAddAccountDialog {...common} initialMode={state.codexMode} />
    case "opencode":
      return <OpencodeAddAccountDialog {...common} />
  }
}

function HealthIcon({ health }: { health: AccountSummary["health"] }) {
  return health === "ready" ? (
    <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
  ) : health === "reauth_required" ? (
    <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
  ) : (
    <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}: </span>
      <span className="break-all">{value}</span>
    </div>
  )
}

function EmptyDetail() {
  const t = useTranslations("subscription.accountCenter")
  return (
    <Card>
      <CardContent className="p-6 text-sm text-muted-foreground">{t("emptyDetail")}</CardContent>
    </Card>
  )
}

function accountKey(account: AccountSummary): string {
  return `${account.provider}:${account.id}`
}

function accountName(account: AccountSummary): string {
  return account.label || account.email || account.id.slice(0, 8)
}

function healthBadgeVariant(
  health: AccountSummary["health"]
): "default" | "secondary" | "destructive" | "outline" {
  if (health === "reauth_required") return "destructive"
  if (health === "ready") return "secondary"
  return "outline"
}
