"use client"

// Export / import the whole appearance config as a shareable JSON file. Sits in
// the Appearance section header next to the shell's section-reset button.
// Export downloads the current appearance slice (the shared `downloadFile`,
// which hands the file to the native share sheet on the phone) and only says
// "exported" once that actually happened; import validates the file, shows a
// confirm dialog (it overwrites the current look, wallpapers aside), and
// applies it through the generic `save()` setter.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, UploadIcon } from "lucide-react"
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
import { usePlatform } from "@/hooks/use-platform"
import { downloadFile } from "@/lib/files/download"
import { useSettingsStore } from "@/stores/settings"
import {
  countConfigKeys,
  exportAppearanceConfig,
  importAppearanceConfig,
  type AppearanceConfigPatch,
} from "@/lib/appearance/appearance-config-io"

/**
 * `accept` for the import picker. The Capacitor Android WebView turns `accept`
 * into the picker intent's MIME filter, and a document-only filter such as
 * `application/json` left no picker that would open on some OEM builds, so the
 * import button did nothing. The file is validated after reading anyway, so
 * the phone drops the filter.
 */
const IMPORT_ACCEPT = "application/json,.json"

/** yyyymmdd-hhmm — a human-sortable filename stamp, computed at click time. */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function AppearanceConfigToolbar() {
  const t = useTranslations("settings.appearance.io")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const nativeMobile = usePlatform() === "mobile"
  const [pending, setPending] = useState<AppearanceConfigPatch | null>(null)

  const handleExport = async () => {
    try {
      const outcome = await downloadFile(
        `cognia-appearance-${stamp()}.json`,
        exportAppearanceConfig(settings ?? {}),
        "application/json"
      )
      if (outcome.kind === "error") {
        toast.error(t("exportFailed", { message: outcome.message }))
      } else if (outcome.kind !== "cancelled") {
        toast.success(t("exportSuccess"))
      }
    } catch (err) {
      toast.error(t("exportFailed", { message: (err as Error).message }))
    }
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    try {
      setPending(importAppearanceConfig(await file.text()))
    } catch (err) {
      toast.error(t("importInvalid", { message: (err as Error).message }))
    }
  }

  const confirmImport = async () => {
    if (!pending) return
    const count = countConfigKeys(pending)
    await save(pending)
    toast.success(t("importSuccess", { count }))
    setPending(null)
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={() => void handleExport()}
      >
        <DownloadIcon className="size-3" />
        {t("export")}
      </Button>
      {/* A label around the input, not a button that `.click()`s a hidden one:
          the tap lands on the file input itself, the same shape as the chat
          attachment picker that opens reliably inside the mobile WebView. */}
      <Button variant="outline" size="sm" className="h-7 cursor-pointer gap-1 text-xs" asChild>
        <label data-testid="appearance-import-trigger">
          <UploadIcon className="size-3" />
          {t("import")}
          <input
            type="file"
            accept={nativeMobile ? undefined : IMPORT_ACCEPT}
            className="sr-only"
            data-testid="appearance-import-input"
            onChange={(e) => {
              void handleFile(e.target.files?.[0])
              // Reset so re-selecting the same file fires `change` again.
              e.target.value = ""
            }}
          />
        </label>
      </Button>
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirm.body", { count: pending ? countConfigKeys(pending) : 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmImport()}>
              {t("confirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
