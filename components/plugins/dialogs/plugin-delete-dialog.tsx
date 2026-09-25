"use client"

// Uninstall (delete) confirmation. Mirrors components/skills/skill-delete-
// dialog.tsx but adds an opt-in "cascade" toggle that also drops the plugin's
// stored data, permissions and analytics (`uninstallPluginForHost` with
// `cascade`). The runtime teardown, file removal and scheduled-job cleanup
// always run.
//
// Exactly ONE outcome per dialog. Radix's Action and Cancel both close the
// dialog through `onOpenChange(false)`, so wiring `onCancel` to both the
// Cancel click and `onOpenChange` — and letting Action close the dialog on top
// of `onConfirm` — advanced a batch-uninstall queue twice per answer and
// silently skipped every other selected plugin. Now:
//   - Action prevents the default close, runs `onConfirm`, and the host
//     advances once after the uninstall settles;
//   - Cancel, Escape and the overlay all reach `onCancel` through
//     `onOpenChange(false)` only.
// While an uninstall is in flight the dialog cannot be dismissed, so a second
// answer cannot race the first.

import { useState } from "react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"

interface Props {
  open: boolean
  pluginName: string
  onCancel: () => void
  onConfirm: (options: { cascade: boolean }) => void | Promise<void>
}

export function PluginDeleteDialog({ open, pluginName, onCancel, onConfirm }: Props) {
  const t = useTranslations("plugins.delete")
  const [cascade, setCascade] = useState(false)
  const [pending, setPending] = useState(false)

  const confirm = async () => {
    setPending(true)
    try {
      await onConfirm({ cascade })
    } finally {
      setPending(false)
      setCascade(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next || pending) return
        setCascade(false)
        onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("body", { name: pluginName })}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-start gap-2 rounded-md border p-3">
          <Checkbox
            id="plugin-delete-cascade"
            checked={cascade}
            disabled={pending}
            onCheckedChange={(v) => setCascade(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor="plugin-delete-cascade" className="space-y-1">
            <div className="text-sm font-medium">{t("cascadeLabel")}</div>
            <p className="text-xs text-muted-foreground font-normal">{t("cascadeHint")}</p>
          </Label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={(event) => {
              // Keep the dialog open until the uninstall settles; the host
              // closes it (or advances the queue) exactly once afterwards.
              event.preventDefault()
              void confirm()
            }}
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            {pending ? t("confirming") : t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
