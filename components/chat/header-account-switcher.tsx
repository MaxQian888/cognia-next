"use client"

// Session account selection for subscription-backed providers. The trigger
// always shows the effective account, including inherited character/app/active
// choices; selecting "Use inherited account" clears only the session pin.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UserIcon } from "lucide-react"

import { getActiveCredential } from "@cognia/provider-core/providers/completeness"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { updateSession } from "@/lib/db/sessions"
import { subscriptionAccountProviderFor } from "@/lib/claude/env-resolver"
import { useAccounts, useSubscriptionProviders } from "@/lib/subscription/core/hooks"
import { useSettingsStore } from "@/stores/settings"
import type { AccountSummary, ProviderId } from "@/types/subscription"
import type { ChatSession } from "@cognia/agent-config-types"

type DisplayAccount = Pick<AccountSummary, "id" | "label" | "email">

function accountLabel(account: DisplayAccount | undefined): string | null {
  if (!account) return null
  return account.label?.trim() || account.email?.trim() || account.id.slice(0, 8)
}

export interface HeaderAccountSwitcherProps {
  session: ChatSession | null
  characterProviderId?: string
  characterAccountIdOverride?: string
  /** Story/test seam that replaces the live summaries without disabling events. */
  testAccounts?: DisplayAccount[]
}

export function HeaderAccountSwitcher({
  session,
  characterProviderId,
  characterAccountIdOverride,
  testAccounts,
}: HeaderAccountSwitcherProps) {
  const t = useTranslations("chat.header.accountSwitcher")
  const settings = useSettingsStore((state) => state.settings)
  const rawProviderId =
    session?.providerOverride ?? characterProviderId ?? settings?.defaultProvider ?? "anthropic"
  const providers = useSubscriptionProviders()
  const definition = providers.find(
    (entry) =>
      entry.id === rawProviderId ||
      entry.plans?.some((plan) => plan.chatProviderId === rawProviderId)
  )
  const subscriptionProvider = definition?.id ?? subscriptionAccountProviderFor(rawProviderId)
  const providerId: ProviderId = subscriptionProvider ?? "anthropic"
  const live = useAccounts(providerId)
  const accounts = testAccounts ?? live.accounts
  const [sessionSelection, setSessionSelection] = useState({
    sessionId: session?.id,
    accountId: session?.accountId,
    authoritativeAccountId: session?.accountId,
  })
  const [savingSessionId, setSavingSessionId] = useState<string | null>(null)
  if (
    sessionSelection.sessionId !== session?.id ||
    sessionSelection.authoritativeAccountId !== session?.accountId
  ) {
    setSessionSelection({
      sessionId: session?.id,
      accountId: session?.accountId,
      authoritativeAccountId: session?.accountId,
    })
  }
  const sessionAccountId =
    sessionSelection.sessionId === session?.id &&
    sessionSelection.authoritativeAccountId === session?.accountId
      ? sessionSelection.accountId
      : session?.accountId

  const inheritedAccountId = useMemo(
    () =>
      characterAccountIdOverride ??
      settings?.defaultAccountIds?.[providerId] ??
      (settings?.defaultProvider === rawProviderId || settings?.defaultProvider === providerId
        ? settings.defaultAccountId
        : undefined) ??
      live.activeAccountId ??
      undefined,
    [
      characterAccountIdOverride,
      live.activeAccountId,
      providerId,
      rawProviderId,
      settings?.defaultAccountId,
      settings?.defaultAccountIds,
      settings?.defaultProvider,
    ]
  )
  const inheritsManualKey =
    definition?.authMode !== "anthropic-oauth" &&
    !characterAccountIdOverride &&
    Boolean(getActiveCredential(settings?.providerSettings?.[rawProviderId]))
  const usesManualKey = !sessionAccountId && inheritsManualKey
  const inheritedLabel =
    accountLabel(accounts.find((account) => account.id === inheritedAccountId)) ?? t("noOverride")
  const effectiveAccountId = sessionAccountId ?? inheritedAccountId
  const effectiveAccount = accounts.find((account) => account.id === effectiveAccountId)
  const effectiveLabel =
    (usesManualKey ? t("manualApiKey") : accountLabel(effectiveAccount)) ??
    (effectiveAccountId
      ? t("unavailableWithId", { id: effectiveAccountId.slice(0, 8) })
      : t("noOverride"))

  if (
    !subscriptionProvider ||
    (!sessionAccountId && (accounts.length === 0 || (accounts.length === 1 && !inheritsManualKey)))
  )
    return null

  const saveSessionAccount = async (accountId: string | undefined, label: string) => {
    if (!session || sessionAccountId === accountId || savingSessionId === session.id) return
    setSavingSessionId(session.id)
    try {
      await updateSession(session.id, { accountId })
      setSessionSelection({
        sessionId: session.id,
        accountId,
        authoritativeAccountId: session.accountId,
      })
      toast.success(accountId ? t("toast", { label }) : t("inheritedToast", { label }))
    } catch (cause) {
      toast.error(
        t("switchFailed", { error: cause instanceof Error ? cause.message : String(cause) })
      )
    } finally {
      setSavingSessionId((current) => (current === session.id ? null : current))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          data-testid="header-account-switcher"
          aria-label={t("aria")}
          disabled={savingSessionId === session?.id}
        >
          <UserIcon className="size-3" aria-hidden="true" />
          <span>{effectiveLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem
          onSelect={() =>
            void saveSessionAccount(
              undefined,
              inheritsManualKey ? t("manualApiKey") : inheritedLabel
            )
          }
          data-testid="account-option-inherited"
        >
          {t(inheritsManualKey ? "manualApiKey" : "useInherited")}
          {!sessionAccountId && (
            <span className="ml-auto text-[10px] text-muted-foreground">{t("effective")}</span>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {accounts.map((account) => {
          const label = accountLabel(account) ?? account.id.slice(0, 8)
          return (
            <DropdownMenuItem
              key={account.id}
              onSelect={() => void saveSessionAccount(account.id, label)}
              data-testid={`account-option-${account.id}`}
            >
              {label}
              {!usesManualKey && effectiveAccountId === account.id && (
                <span className="ml-auto text-[10px] text-muted-foreground">{t("effective")}</span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
