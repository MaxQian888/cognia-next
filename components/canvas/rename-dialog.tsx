"use client"

/**
 * RenameDialog - Shared rename dialog component for Canvas documents
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentTitle: string
  onRename: (newTitle: string) => void
}

export function RenameDialog({ open, onOpenChange, currentTitle, onRename }: RenameDialogProps) {
  const t = useTranslations("canvas")
  const [value, setValue] = useState(currentTitle)
  const [lastTitle, setLastTitle] = useState(currentTitle)

  // Sync value when currentTitle changes or dialog opens
  if (open && currentTitle !== lastTitle) {
    setValue(currentTitle)
    setLastTitle(currentTitle)
  }

  const handleConfirm = () => {
    if (value.trim()) {
      onRename(value.trim())
      onOpenChange(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleConfirm()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("renameDocument")}</DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-2">
          <Label htmlFor="rename-input">{t("documentTitle")}</Label>
          <Input
            id="rename-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("documentTitle")}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={!value.trim()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
