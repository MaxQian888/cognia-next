"use client"

/**
 * The merge-or-replace choice (ADR-0215 phase 3a, protocol §5.4), opened by
 * the data engine when this device and the account both hold data.
 *
 * Continuing first saves a backup of this device through the normal backup
 * flow (a save dialog on desktop, a download on the web, recorded in backup
 * history). A cancelled or failed backup changes nothing and leaves the
 * choice open.
 */

import { useState } from "react"
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
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { useFullBackup } from "@/hooks/data/use-full-backup"
import type { JoinChoice } from "@/lib/account-sync/data/join"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

const COUNTED = ["sessions", "messages", "characters", "skills", "memories"] as const

class BackupCanceled extends Error {}

export function JoinChoiceDialog() {
  const t = useTranslations("accountSync.joinChoice")
  const engine = useAccountSyncStore((state) => state.engine)
  const status = useAccountSyncStore((state) => state.engineStatus)
  const open = useAccountSyncStore((state) => state.joinDialogOpen)
  const setOpen = useAccountSyncStore((state) => state.setJoinDialogOpen)
  const { run } = useFullBackup()
  const [choice, setChoice] = useState<JoinChoice>("merge")
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!engine || status?.kind !== "join-choice") return null
  const counts = status.local.counts

  const backup = async () => {
    const result = await run({
      includeSessions: true,
      includeApiKey: false,
      encryption: "auto-key",
      type: "auto",
    })
    if (!result.ok) throw new Error(result.error)
    if (result.canceled) throw new BackupCanceled()
  }

  const onContinue = async () => {
    setWorking(true)
    setError(null)
    try {
      await engine.join(choice, backup)
    } catch (caught) {
      setError(
        caught instanceof BackupCanceled
          ? t("canceled")
          : t("failed", { message: caught instanceof Error ? caught.message : String(caught) })
      )
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !working && setOpen(next)}>
      <DialogContent data-testid="account-sync-join-choice">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{t("onDevice")}</p>
          <ul
            className="flex flex-wrap gap-x-3 gap-y-1 text-sm"
            data-testid="account-sync-join-counts"
          >
            {COUNTED.filter((table) => (counts[table] ?? 0) > 0).map((table) => (
              <li key={table}>{t(`counts.${table}`, { count: counts[table] })}</li>
            ))}
          </ul>
        </div>
        <RadioGroup
          value={choice}
          onValueChange={(value) => setChoice(value as JoinChoice)}
          className="gap-3"
          disabled={working}
        >
          {(["merge", "replace"] as const).map((option) => (
            <div key={option} className="flex items-start gap-2">
              <RadioGroupItem
                value={option}
                id={`account-sync-join-${option}`}
                data-testid={`account-sync-join-${option}`}
              />
              <Label
                htmlFor={`account-sync-join-${option}`}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">{t(option)}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t(`${option}Hint`)}
                </span>
              </Label>
            </div>
          ))}
        </RadioGroup>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={working}
            onClick={() => setOpen(false)}
            data-testid="account-sync-join-later"
          >
            {t("later")}
          </Button>
          <Button
            type="button"
            disabled={working}
            onClick={() => void onContinue()}
            data-testid="account-sync-join-continue"
          >
            {working ? (
              <>
                <Spinner className="size-3" />
                {t("backingUp")}
              </>
            ) : (
              t("continue")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
