"use client"

/**
 * Settings header actions — a portable "settings profile" menu mounted in the
 * shell's `actions` slot. Export the current configuration to JSON (secrets
 * stripped), import a profile from a file, or reset all preferences to default.
 *
 * Reuses the shared download helper (`lib/files/download`), the profile
 * transfer core (`lib/settings/profile-transfer`), and shadcn DropdownMenu /
 * AlertDialog primitives — no bespoke dialog plumbing.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, MoreVerticalIcon, RotateCcwIcon, UploadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { downloadFile } from "@/lib/files/download"
import {
  exportSettingsProfile,
  serializeSettingsProfile,
  importSettingsProfile,
} from "@/lib/settings/profile-transfer"

const IMPORT_ERROR_KEYS = new Set([
  "invalidJson",
  "invalidPayload",
  "wrongSchema",
  "missingVersion",
  "versionTooNew",
  "missingSettings",
  "emptyProfile",
])

export function SettingsActionsMenu() {
  const t = useTranslations("settings.actions")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const resetSettings = useSettingsStore((s) => s.resetSettings)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [resetOpen, setResetOpen] = useState(false)

  const handleExport = () => {
    if (!settings) return
    const profile = exportSettingsProfile(settings, new Date().toISOString())
    const stamp = new Date().toISOString().split("T")[0]
    downloadFile(
      `cognia-settings-${stamp}.json`,
      serializeSettingsProfile(profile),
      "application/json"
    )
    toast.success(t("exportedToast"))
  }

  const handleFile = async (file: File) => {
    try {
      const text = await file.text()
      const result = importSettingsProfile(text)
      if (!result.ok) {
        const key = IMPORT_ERROR_KEYS.has(result.errorKey) ? result.errorKey : "generic"
        toast.error(t(`importErrors.${key}` as never))
        return
      }
      await save(result.patch)
      toast.success(t("importedToast"))
    } catch {
      toast.error(t("importErrors.generic"))
    }
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleFile(file)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const handleReset = async () => {
    await resetSettings()
    setResetOpen(false)
    toast.success(t("resetToast"))
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={t("triggerAria")}
            data-testid="settings-actions-trigger"
          >
            <MoreVerticalIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={handleExport} data-testid="settings-export">
            <DownloadIcon className="mr-2 h-4 w-4" />
            {t("export")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => fileInputRef.current?.click()}
            data-testid="settings-import"
          >
            <UploadIcon className="mr-2 h-4 w-4" />
            {t("import")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setResetOpen(true)}
            data-testid="settings-reset"
          >
            <RotateCcwIcon className="mr-2 h-4 w-4" />
            {t("resetAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFileChange}
        data-testid="settings-import-input"
      />

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("resetDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset} data-testid="settings-reset-confirm">
              {t("resetConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
