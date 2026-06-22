"use client"

import type { FormEvent } from "react"
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon, UserRoundIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useAccountStore } from "@/stores/account/account-store"

export interface AccountManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AccountManageDialog({ open, onOpenChange }: AccountManageDialogProps) {
  const t = useTranslations("account.manage")
  const accounts = useAccountStore((state) => state.accounts)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const createAccount = useAccountStore((state) => state.createAccount)
  const renameAccount = useAccountStore((state) => state.renameAccount)
  const deleteAccount = useAccountStore((state) => state.deleteAccount)
  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [accounts]
  )
  const [selectedId, setSelectedId] = useState<string | null>(sorted[0]?.id ?? null)
  const selected = sorted.find((account) => account.id === selectedId) ?? sorted[0] ?? null
  const [newDisplayName, setNewDisplayName] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [editDisplayName, setEditDisplayName] = useState(selected?.displayName ?? "")
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const replacementAccountId =
    selected?.id === activeAccountId
      ? sorted.find((account) => account.id !== selected.id)?.id
      : undefined
  const canDelete = Boolean(selected && (selected.id !== activeAccountId || replacementAccountId))

  const handleSelect = (accountId: string) => {
    const account = sorted.find((candidate) => candidate.id === accountId)
    setSelectedId(accountId)
    setEditDisplayName(account?.displayName ?? "")
    setConfirmingDelete(false)
    setError(null)
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await createAccount({
        displayName: newDisplayName,
        password: newPassword,
      })
      setNewDisplayName("")
      setNewPassword("")
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    } finally {
      setSubmitting(false)
    }
  }

  const handleRename = async () => {
    if (!selected) return
    setSubmitting(true)
    setError(null)
    try {
      await renameAccount(selected.id, editDisplayName)
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!selected || !canDelete) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await deleteAccount(selected.id, { replacementAccountId })
      setConfirmingDelete(false)
    } catch (err) {
      setError(toErrorMessage(err, t("operationFailed")))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(0,12rem)_1fr] gap-4">
          <div className="flex flex-col gap-3">
            <form className="flex flex-col gap-2" onSubmit={(event) => void handleCreate(event)}>
              <Label htmlFor="account-new-display-name">{t("newDisplayNameLabel")}</Label>
              <Input
                id="account-new-display-name"
                value={newDisplayName}
                placeholder={t("newDisplayNamePlaceholder")}
                onChange={(event) => setNewDisplayName(event.target.value)}
              />
              <Label htmlFor="account-new-password">{t("newPasswordLabel")}</Label>
              <Input
                id="account-new-password"
                value={newPassword}
                type="password"
                autoComplete="new-password"
                placeholder={t("newPasswordPlaceholder")}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={submitting} className="gap-2">
                <PlusIcon className="size-4" />
                {t("createAccount")}
              </Button>
            </form>
            <Separator />
            <ScrollArea className="h-72">
              <ul className="flex flex-col gap-1 pr-2" aria-label={t("listLabel")}>
                {sorted.map((account) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(account.id)}
                      data-testid={`account-manage-row-${account.id}`}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                        selected?.id === account.id && "bg-primary/10 text-foreground"
                      )}
                    >
                      <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{account.displayName}</span>
                      {activeAccountId === account.id && (
                        <span className="text-[10px] text-muted-foreground">
                          {t("activeBadge")}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>

          <div className="min-w-0">
            {!selected ? (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t("empty")}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="account-edit-display-name">{t("editDisplayNameLabel")}</Label>
                  <Input
                    id="account-edit-display-name"
                    value={editDisplayName}
                    onChange={(event) => setEditDisplayName(event.target.value)}
                  />
                </div>
                {error && (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
                  >
                    {error}
                  </p>
                )}
                <Separator />
                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant={confirmingDelete ? "destructive" : "ghost"}
                    size="sm"
                    disabled={!canDelete || submitting}
                    onClick={() => void handleDelete()}
                    className="gap-2"
                  >
                    <Trash2Icon className="size-4" />
                    {confirmingDelete ? t("confirmDelete") : t("delete")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={submitting}
                    onClick={() => void handleRename()}
                  >
                    {t("save")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

export default AccountManageDialog
