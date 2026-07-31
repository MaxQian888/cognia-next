"use client"

// Uninstall (delete) confirmation. Mirrors components/skills/skill-delete-
// dialog.tsx but adds an opt-in "cascade" toggle that wipes the plugin's
// stored permissions / analytics. SchedulerDB tasks are always removed by
// the uninstall lifecycle. Without cascade, only the
// plugin row is removed.

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

interface Props {
  open: boolean
  pluginName: string
  onCancel: () => void
  onConfirm: (options: { cascade: boolean }) => void
}

export function PluginDeleteDialog({ open, pluginName, onCancel, onConfirm }: Props) {
  const t = useTranslations("plugins.delete")
  const [cascade, setCascade] = useState(false)

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setCascade(false)
          onCancel()
        }
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
            onCheckedChange={(v) => setCascade(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor="plugin-delete-cascade" className="space-y-1">
            <div className="text-sm font-medium">{t("cascadeLabel")}</div>
            <p className="text-xs text-muted-foreground font-normal">{t("cascadeHint")}</p>
          </Label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              setCascade(false)
              onCancel()
            }}
          >
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onConfirm({ cascade })
              setCascade(false)
            }}
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
