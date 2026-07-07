"use client"

/**
 * Compact account control for the desktop title/status bars. Reuses the account
 * store (active account + `lock`) and delegates the full switch/manage flow to
 * the shared `AccountManageDialog` — so both bars expose account switching and a
 * one-click lock without duplicating the account list UI (that lives in the
 * dialog and in the guild-rail `AccountSwitcher`). Renders `null` when no local
 * accounts exist, matching `AccountSwitcher`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LockKeyholeIcon, SettingsIcon, UserRoundIcon } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"

import { AccountManageDialog } from "./account-manage-dialog"

export function AccountBarButton({ className }: { className?: string }) {
  const t = useTranslations("account.switcher")
  const accounts = useAccountStore((state) => state.accounts)
  const lock = useAccountStore((state) => state.lock)
  const activeAccount = useAccountStore(selectActiveAccount)
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  if (accounts.length === 0) return null

  const triggerLabel = activeAccount
    ? t("active", { name: activeAccount.displayName })
    : t("noActive")
  const initial = activeAccount?.displayName.trim().charAt(0).toUpperCase()

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={triggerLabel}
            title={triggerLabel}
            data-testid="account-bar-button"
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              className
            )}
          >
            {initial ? (
              <span className="text-[11px] font-semibold">{initial}</span>
            ) : (
              <UserRoundIcon aria-hidden className="size-3.5" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={4} className="w-56 p-1">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {activeAccount ? activeAccount.displayName : t("noActive")}
          </div>
          <button
            type="button"
            onClick={() => {
              lock()
              setOpen(false)
            }}
            data-testid="account-bar-lock"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <LockKeyholeIcon aria-hidden className="size-4 text-muted-foreground" />
            {t("lock")}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setManageOpen(true)
            }}
            data-testid="account-bar-manage"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <SettingsIcon aria-hidden className="size-4 text-muted-foreground" />
            {t("manage")}
          </button>
        </PopoverContent>
      </Popover>

      <AccountManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  )
}

export default AccountBarButton
