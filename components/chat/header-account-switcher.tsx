"use client"

// ADR-0028 §UI surfaces — chat-header account badge + switcher.
//
// Hidden when the user has at most one account for the active provider
// (the badge would just clutter the header). Selecting a different
// account writes `session.accountId` and surfaces a sonner toast
// confirming the next send will use the new account.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UserIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { listAccounts } from "@/lib/subscription/core/transport"
import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import type { ChatSession } from "@cognia/agent-config-types"

type Account = {
  id: string
  label?: string
}

type ProviderId = "anthropic" | "codex" | "opencode"

async function loadAccounts(provider: string): Promise<Account[]> {
  try {
    const list = await listAccounts(provider as ProviderId)
    return list.map((acc) => ({ id: acc.id, label: acc.label }))
  } catch {
    return []
  }
}

export interface HeaderAccountSwitcherProps {
  session: ChatSession | null
  characterProviderId?: string
  characterAccountIdOverride?: string
  /** Test-only — force-pass an account list and skip the IPC fetch. */
  testAccounts?: Account[]
}

export function HeaderAccountSwitcher({
  session,
  characterProviderId,
  characterAccountIdOverride,
  testAccounts,
}: HeaderAccountSwitcherProps) {
  const t = useTranslations("chat.header.accountSwitcher")
  const settings = useSettingsStore((s) => s.settings)
  const providerId = useMemo(
    () =>
      session?.providerOverride ?? characterProviderId ?? settings?.defaultProvider ?? "anthropic",
    [session?.providerOverride, characterProviderId, settings?.defaultProvider]
  )

  const [accounts, setAccounts] = useState<Account[]>(testAccounts ?? [])

  useEffect(() => {
    if (testAccounts) return
    let cancelled = false
    void loadAccounts(providerId).then((next) => {
      if (!cancelled) setAccounts(next)
    })
    return () => {
      cancelled = true
    }
  }, [providerId, testAccounts])

  // The ADR says: "hidden when the user has one account".
  if (accounts.length <= 1) return null

  const activeId = session?.accountId ?? characterAccountIdOverride ?? settings?.defaultAccountId
  const activeAccount = accounts.find((a) => a.id === activeId)
  const activeLabel = activeAccount?.label ?? activeAccount?.id.slice(0, 8) ?? t("noOverride")

  const handlePick = async (account: Account) => {
    if (!session) return
    if (session.accountId === account.id) return
    await updateSession(session.id, { accountId: account.id })
    toast.success(t("toast", { label: account.label ?? account.id.slice(0, 8) }))
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
        >
          <UserIcon className="size-3" aria-hidden="true" />
          <span>{activeLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {accounts.map((account) => (
          <DropdownMenuItem
            key={account.id}
            onSelect={() => void handlePick(account)}
            data-testid={`account-option-${account.id}`}
          >
            {account.label ?? account.id.slice(0, 8)}
            {session?.accountId === account.id && (
              <span className="ml-auto text-[10px] text-muted-foreground">{t("active")}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
