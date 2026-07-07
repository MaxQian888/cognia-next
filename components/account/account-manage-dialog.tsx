"use client"

/**
 * Local-account management dialog (desktop-only). A responsive master-detail:
 * a searchable account list on the left and a tabbed detail pane (Profile /
 * Security / Danger zone) on the right, with inline switch/unlock. The dialog
 * content is a `@container`, so it lays out two columns at `@lg` and collapses
 * to a single column (list → detail with a back button) on narrow windows.
 *
 * This shell owns only selection + the narrow-layout view; all account state
 * comes from the account store and all mutations live in the child components.
 * The public `AccountManageDialog` / `AccountManageDialogProps` surface is
 * unchanged so both mount sites (settings overview, rail switcher) are untouched.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { useAccountStore } from "@/stores/account/account-store"

import { AccountList } from "./manage/account-list"
import { AccountDetail } from "./manage/account-detail"

export interface AccountManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AccountManageDialog({ open, onOpenChange }: AccountManageDialogProps) {
  const t = useTranslations("account.manage")
  const accounts = useAccountStore((state) => state.accounts)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const error = useAccountStore((state) => state.error)

  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [accounts]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Narrow (single-column) layout only: which pane is visible. Ignored at `@lg`
  // where both columns render side by side.
  const [narrowView, setNarrowView] = useState<"list" | "detail">("list")

  const selected: LocalAccountRecord | null =
    sorted.find((account) => account.id === selectedId) ?? sorted[0] ?? null

  const select = (accountId: string) => {
    setSelectedId(accountId)
    setNarrowView("detail")
  }
  const handleCreated = (account: LocalAccountRecord) => {
    setSelectedId(account.id)
    setNarrowView("detail")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pr-10 pb-4">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="@container min-h-0 flex-1 overflow-hidden px-6 pb-6">
          <div className="grid h-full min-h-0 gap-4 @lg:grid-cols-[minmax(0,15rem)_1fr]">
            <div
              className={cn("flex min-h-0 flex-col", narrowView === "detail" && "hidden @lg:flex")}
              data-testid="account-manage-list-col"
            >
              <AccountList
                accounts={accounts}
                activeAccountId={activeAccountId}
                unlockedAccountId={unlockedAccountId}
                selectedId={selected?.id ?? null}
                onSelect={select}
                onCreated={handleCreated}
                error={error}
              />
            </div>
            <div
              className={cn("min-h-0 overflow-y-auto", narrowView === "list" && "hidden @lg:block")}
              data-testid="account-manage-detail-col"
            >
              <AccountDetail
                account={selected}
                accounts={accounts}
                activeAccountId={activeAccountId}
                unlockedAccountId={unlockedAccountId}
                showBack
                onBack={() => setNarrowView("list")}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default AccountManageDialog
