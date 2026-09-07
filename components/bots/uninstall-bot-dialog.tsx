"use client"

/**
 * Remove an installation, and say what goes with it.
 *
 * The body names the consequences rather than asking "are you sure": an
 * uninstall drops the scheduler tasks its armed triggers reconciled, and any
 * dead-lettered deliveries stop being replayable. A user who reads only the
 * title should still be able to tell this apart from disabling the Bot, which
 * is the reversible action sitting next to it.
 *
 * An ORPHAN can be removed, and the body says something different for one. It
 * is the single state where removal is the only remaining action, and gating
 * it on a definition that no longer exists would strand the row along with
 * whatever it still owns.
 */

import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useBotLifecycleActions } from "@/hooks/bots/use-bot-lifecycle-actions"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

export interface UninstallBotDialogProps {
  row: BotConsoleRow
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Called after the row is gone, so the console can clear its selection. */
  onUninstalled?: () => void
}

export function UninstallBotDialog({
  row,
  open,
  onOpenChange,
  onUninstalled,
}: UninstallBotDialogProps) {
  const t = useTranslations("bots")
  const actions = useBotLifecycleActions()
  const busy = actions.pending.has(`uninstall:${row.id}`)

  const confirm = async () => {
    const removed = await actions.uninstall(row.id)
    // Only close on success. A refused uninstall that closed the dialog would
    // leave the row on screen with nothing saying why it is still there.
    if (!removed) return
    onOpenChange(false)
    onUninstalled?.()
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="uninstall-bot-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("uninstall.title", { name: row.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {row.orphaned ? t("uninstall.orphanBody") : t("uninstall.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("uninstall.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              // Radix closes on click by default. The dialog has to outlive the
              // write so a refusal can keep it open with the toast beside it.
              event.preventDefault()
              void confirm()
            }}
            data-testid="uninstall-bot-confirm"
          >
            {t("uninstall.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
