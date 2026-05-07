"use client"

// Dialog wrapper around `VscodeImportForm`. Triggered from the Theme tab
// header so users don't have to switch tabs to import a single .json file.

import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { VscodeImportForm } from "./vscode-import-form"

export interface VscodeImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function VscodeImportDialog({ open, onOpenChange }: VscodeImportDialogProps) {
  const t = useTranslations("settings.appearance.vscode")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <VscodeImportForm showDescription={false} onComplete={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
