"use client"

/**
 * Standardized per-section "reset to defaults" affordance. Mounts only for
 * sections with a clean, self-contained key-set (see `resetKeysForSection`);
 * for unmapped sections it renders nothing, so callers can drop it in
 * unconditionally.
 *
 * Reuses the shared reset core (`resetSettings` + `resetKeysForSection`) and an
 * AlertDialog confirm — no per-section reset plumbing.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
import { useSettingsStore } from "@/stores/settings"
import { resetKeysForSection } from "@/lib/settings/section-keys"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"

export function SectionResetButton({ sectionId }: { sectionId: SettingsSectionId }) {
  const t = useTranslations("settings.sectionReset")
  const resetSettings = useSettingsStore((s) => s.resetSettings)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const keys = resetKeysForSection(sectionId)
  if (!keys) return null

  const onConfirm = async () => {
    setBusy(true)
    try {
      await resetSettings(keys)
      toast.success(t("toast"))
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="section-reset-button"
      >
        <RotateCcwIcon className="mr-2 size-3.5" />
        {t("button")}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void onConfirm()
              }}
              disabled={busy}
              data-testid="section-reset-confirm"
            >
              {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
