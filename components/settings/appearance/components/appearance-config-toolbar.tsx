"use client"

// Export / import the whole appearance config as a shareable JSON file. Sits in
// the Appearance section header next to the shell's section-reset button.
// Export downloads the current appearance slice; import validates the file,
// shows a confirm dialog (it overwrites the current look, wallpapers aside),
// and applies it through the generic `save()` setter.

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import {
  countConfigKeys,
  exportAppearanceConfig,
  importAppearanceConfig,
  type AppearanceConfigPatch,
} from "@/lib/appearance/appearance-config-io"

function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

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
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<AppearanceConfigPatch | null>(null)

  const handleExport = () => {
    downloadJson(`cognia-appearance-${stamp()}.json`, exportAppearanceConfig(settings ?? {}))
    toast.success(t("exportSuccess"))
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
      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={handleExport}>
        <DownloadIcon className="size-3" />
        {t("export")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={() => inputRef.current?.click()}
      >
        <UploadIcon className="size-3" />
        {t("import")}
      </Button>
      <Input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        data-testid="appearance-import-input"
        onChange={(e) => {
          void handleFile(e.target.files?.[0])
          // Reset so re-selecting the same file fires `change` again.
          e.target.value = ""
        }}
      />
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
