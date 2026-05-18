"use client"

// Shared multi-account list with one-click switch + rename + delete. Reused
// by the Claude / Codex / OpenCode provider tabs.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, MoreVerticalIcon, RadioIcon } from "lucide-react"

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { useAccounts } from "@/lib/subscription/core/hooks"
import type { AccountSummary, ProviderId } from "@/lib/subscription/core/types"

interface AccountListProps {
  provider: ProviderId
  onAdd?: () => void
  /**
   * Custom secondary action surfaced as a single ghost button next to "Add
   * account" (e.g. "Adopt discovered" for OpenCode).
   */
  secondaryAction?: React.ReactNode
}

export function AccountList({ provider, onAdd, secondaryAction }: AccountListProps) {
  const t = useTranslations("subscription.common.accountList")
  const { accounts, activeAccountId, loading, setActive, rename, remove } = useAccounts(provider)

  const [renameTarget, setRenameTarget] = useState<AccountSummary | null>(null)
  const [removeTarget, setRemoveTarget] = useState<AccountSummary | null>(null)

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
                  onClick={() => void setActive(account.id)}
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
                </div>
                {account.id === activeAccountId && (
                  <Badge variant="default" className="text-[10px]">
                    {t("active")}
                  </Badge>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7">
                      <MoreVerticalIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenameTarget(account)} disabled={loading}>
                      {t("rename")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setRemoveTarget(account)}
                      className="text-destructive focus:text-destructive"
                    >
                      {t("remove")}
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
            await rename(renameTarget.id, label)
            setRenameTarget(null)
          }}
        />
      )}
      {removeTarget && (
        <RemoveDialog
          account={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onConfirm={async () => {
            await remove(removeTarget.id)
            setRemoveTarget(null)
          }}
        />
      )}
    </Card>
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
  account,
  onClose,
  onConfirm,
}: {
  account: AccountSummary
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const t = useTranslations("subscription.common.accountList")
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("removeDialogTitle")}</DialogTitle>
          <DialogDescription>
            {account.label || account.email || account.id.slice(0, 8)}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("removeDialogBody")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy}
          >
            {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t("removeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
