"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, LockKeyholeIcon, SettingsIcon, UserRoundIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"

import { AccountManageDialog } from "./account-manage-dialog"
import { useAccountSwitch } from "./manage/use-account-switch"

export function AccountSwitcher() {
  const t = useTranslations("account.switcher")
  const accounts = useAccountStore((state) => state.accounts)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const lock = useAccountStore((state) => state.lock)
  const activeAccount = useAccountStore(selectActiveAccount)
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  // Shared switch/unlock-with-password flow (same one the manage dialog uses).
  const switcher = useAccountSwitch({
    onSwitched: () => setOpen(false),
    operationFailedLabel: t("operationFailed"),
  })

  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [accounts]
  )
  const pendingAccount = sorted.find((account) => account.id === switcher.pendingId) ?? null

  if (accounts.length === 0) return null

  const triggerLabel = activeAccount
    ? t("active", { name: activeAccount.displayName })
    : t("noActive")
  const initial = activeAccount?.displayName.trim().charAt(0).toUpperCase()

  const openManage = () => {
    setOpen(false)
    setManageOpen(true)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={triggerLabel}
                data-testid="account-switcher"
                className="size-10 rounded-2xl text-muted-foreground transition-all hover:rounded-xl hover:text-foreground"
              >
                {initial ? (
                  <span className="text-sm font-semibold">{initial}</span>
                ) : (
                  <UserRoundIcon className="size-5" />
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{triggerLabel}</TooltipContent>
        </Tooltip>

        <PopoverContent side="right" align="start" className="w-64 p-1">
          <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("heading")}
          </div>
          <div className="flex flex-col">
            {sorted.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => void switcher.begin(account.id)}
                data-testid={`account-switch-${account.id}`}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                  activeAccountId === account.id && "bg-primary/10 text-foreground"
                )}
              >
                <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{account.displayName}</span>
                {activeAccountId === account.id && (
                  <>
                    <span className="text-[10px] text-muted-foreground">{t("activeBadge")}</span>
                    <CheckIcon className="size-4 shrink-0 text-primary" />
                  </>
                )}
              </button>
            ))}
          </div>

          {pendingAccount && (
            <>
              <Separator className="my-1" />
              <form
                className="flex flex-col gap-2 p-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void switcher.confirm()
                }}
              >
                <Label htmlFor="account-switch-password">{t("switchPasswordLabel")}</Label>
                <Input
                  id="account-switch-password"
                  type="password"
                  value={switcher.password}
                  autoComplete="current-password"
                  placeholder={t("switchPasswordPlaceholder")}
                  onChange={(event) => switcher.setPassword(event.target.value)}
                />
                {switcher.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {switcher.error}
                  </p>
                )}
                <Button type="submit" size="sm" disabled={switcher.submitting}>
                  {t("confirmSwitch")}
                </Button>
              </form>
            </>
          )}

          <Separator className="my-1" />
          <button
            type="button"
            onClick={() => {
              lock()
              setOpen(false)
            }}
            data-testid="account-switcher-lock"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <LockKeyholeIcon className="size-4 text-muted-foreground" />
            {t("lock")}
          </button>
          <button
            type="button"
            onClick={openManage}
            data-testid="account-switcher-manage"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <SettingsIcon className="size-4 text-muted-foreground" />
            {t("manage")}
          </button>
        </PopoverContent>
      </Popover>

      <AccountManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  )
}

export default AccountSwitcher
