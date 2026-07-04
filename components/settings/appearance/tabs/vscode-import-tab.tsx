"use client"

// VSCode color theme importer. The drop-zone / parse / commit flow is now
// shared with the Theme tab header dialog — this file owns the dedicated
// tab surface (form + the history list of previously imported themes).

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Trash2Icon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import type { ImportedThemeRecord } from "@/types/appearance"
import type { CustomTheme } from "@/types/plugin/plugin"
import { cn } from "@/lib/utils"
import { VscodeImportForm } from "../vscode-import-form"

// Stable empty fallbacks. Selectors that return a fresh `[]` on every call
// confuse zustand's `useSyncExternalStore` integration into thinking the
// store changed every render, which trips React's max-depth guard.
const EMPTY_IMPORTED: ImportedThemeRecord[] = []
const EMPTY_CUSTOM_THEMES: CustomTheme[] = []

export function VscodeImportTab() {
  const t = useTranslations("settings.appearance.vscode")
  const setActive = useSettingsStore((s) => s.setActiveCustomTheme)
  const removeImportedTheme = useSettingsStore((s) => s.removeImportedTheme)
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme)
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const importedRecords = useSettingsStore(
    (s) => s.settings?.importedVscodeThemes ?? EMPTY_IMPORTED
  )
  const customThemes = useSettingsStore((s) => s.settings?.customThemes ?? EMPTY_CUSTOM_THEMES)

  const removeRecord = async (record: ImportedThemeRecord) => {
    deleteCustomTheme(record.customThemeId)
    await removeImportedTheme(record.customThemeId)
  }

  return (
    <div className="space-y-6">
      <VscodeImportForm />

      <div className="space-y-2">
        <Label className="text-xs">{t("history")}</Label>
        {importedRecords.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noThemes")}</p>
        ) : (
          <ul className="space-y-1">
            {importedRecords.map((record) => {
              const ct = customThemes.find((c) => c.id === record.customThemeId)
              const isActive = record.customThemeId === activeCustomThemeId
              return (
                <li
                  key={record.customThemeId}
                  className={cn(
                    "flex flex-col gap-1 rounded border p-2 text-xs sm:flex-row sm:items-center",
                    isActive && "border-primary bg-primary/5"
                  )}
                >
                  <span className="font-medium">
                    {ct?.name ?? record.sourceName}
                    {isActive && (
                      <span className="ml-1.5 text-[10px] text-primary">{t("activeLabel")}</span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {record.origin.kind === "json"
                      ? record.origin.fileName
                      : `${record.origin.vsixName} · ${record.origin.themePath}`}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {isActive ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => void setActive(null)}
                      >
                        {t("deactivateButton")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => void setActive(record.customThemeId)}
                      >
                        {t("activateButton")}
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-destructive"
                      onClick={() => void removeRecord(record)}
                      aria-label={t("removeButton")}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
