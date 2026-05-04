"use client"

// VSCode color theme importer. Two paths:
//   .json  → parsed directly, lands as a single CustomTheme.
//   .vsix  → unzipped, the user picks which contributed themes to import.
// Imported themes go through the existing `createCustomTheme` flow so the
// rest of the appearance pipeline (preview, activate, edit) gets them
// automatically. We also append an `ImportedThemeRecord` to keep
// provenance for the UI.

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Loader2Icon, Trash2Icon, UploadIcon } from "lucide-react"
import {
  importVscodeThemeJson,
  readVsix,
  type ParsedTheme,
  type VsixManifest,
  type VsixThemeReady,
} from "@/lib/appearance"
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"
import { useSettingsStore } from "@/stores/settings"
import type { ImportedThemeRecord } from "@/types/appearance"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"
import { cn } from "@/lib/utils"

// Stable empty fallbacks. Selectors that return a fresh `[]` on every call
// confuse zustand's `useSyncExternalStore` integration into thinking the
// store changed every render, which trips React's max-depth guard.
const EMPTY_IMPORTED: ImportedThemeRecord[] = []
const EMPTY_CUSTOM_THEMES: CustomTheme[] = []

type Stage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "vsix-pick"; manifest: VsixManifest; selected: Set<number>; vsixName: string }
  | { kind: "error"; message: string }
  | { kind: "done"; importedCount: number }

export function VscodeImportTab() {
  const t = useTranslations("settings.appearance.vscode")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })

  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)
  const setActive = useSettingsStore((s) => s.setActiveCustomTheme)
  const addImportedTheme = useSettingsStore((s) => s.addImportedTheme)
  const removeImportedTheme = useSettingsStore((s) => s.removeImportedTheme)
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme)
  const importedRecords = useSettingsStore(
    (s) => s.settings?.importedVscodeThemes ?? EMPTY_IMPORTED
  )
  const customThemes = useSettingsStore((s) => s.settings?.customThemes ?? EMPTY_CUSTOM_THEMES)

  const handleFile = async (file: File) => {
    setStage({ kind: "loading" })
    try {
      if (file.name.toLowerCase().endsWith(".vsix")) {
        const buf = new Uint8Array(await file.arrayBuffer())
        const manifest = await readVsix(buf)
        setStage({
          kind: "vsix-pick",
          manifest,
          // Pre-select every theme so the common case (single-theme VSIX) is one click.
          selected: new Set(manifest.themes.map((_, idx) => idx)),
          vsixName: file.name,
        })
        return
      }
      // Default to JSON.
      const text = await file.text()
      const parsed = importVscodeThemeJson(text)
      const id = await commitTheme(parsed, {
        kind: "json",
        fileName: file.name,
      })
      await setActive(id)
      setStage({ kind: "done", importedCount: 1 })
    } catch (err) {
      setStage({ kind: "error", message: (err as Error).message })
    }
  }

  const commitTheme = async (
    parsed: ParsedTheme,
    origin: ImportedThemeRecord["origin"]
  ): Promise<string> => {
    // The parser still returns the legacy single-variant shape
    // (`{ name, isDark, colors }`) on purpose — keeping the OKLCH math out
    // of `parse-json.ts`. We do the legacy → dual-variant conversion here,
    // at the commit boundary, so newly-imported rows land in the v16
    // shape without going through the migration.
    const baseVariant: "light" | "dark" = parsed.theme.isDark ? "dark" : "light"
    const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
    // The dynamic-key indexing makes TS infer `Partial<{ light, dark }>`
    // even though both keys are always assigned, hence the cast.
    const tokens = {
      [baseVariant]: parsed.theme.colors,
      [opposite]: deriveOppositeVariant(parsed.theme.colors, baseVariant),
    } as { light: ThemeColors; dark: ThemeColors }

    const id = createCustomTheme({
      name: parsed.theme.name,
      baseVariant,
      derivedVariant: opposite,
      tokens,
      // Legacy fields are written too so a one-release rollback to v15
      // (which only reads `colors`/`isDark`) still finds usable data —
      // matches the rollback contract documented in Task 8.
      isDark: parsed.theme.isDark,
      colors: parsed.theme.colors,
    })
    await addImportedTheme({
      customThemeId: id,
      sourceName: parsed.theme.name,
      sourceVariant: parsed.theme.isDark ? "dark" : "light",
      importedAt: Date.now(),
      origin,
    })
    return id
  }

  const finishVsix = async () => {
    if (stage.kind !== "vsix-pick") return
    const { manifest, selected, vsixName } = stage
    setStage({ kind: "loading" })
    try {
      let imported = 0
      let lastId: string | null = null
      for (let idx = 0; idx < manifest.themes.length; idx += 1) {
        if (!selected.has(idx)) continue
        const entry: VsixThemeReady = manifest.themes[idx]
        const parsed = await entry.parse()
        const id = await commitTheme(parsed, {
          kind: "vsix",
          vsixName,
          themePath: entry.path,
        })
        lastId = id
        imported += 1
      }
      if (lastId) await setActive(lastId)
      setStage({ kind: "done", importedCount: imported })
    } catch (err) {
      setStage({ kind: "error", message: (err as Error).message })
    }
  }

  const removeRecord = async (record: ImportedThemeRecord) => {
    deleteCustomTheme(record.customThemeId)
    await removeImportedTheme(record.customThemeId)
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) void handleFile(file)
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm"
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".json,.vsix"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
            e.target.value = ""
          }}
        />
        <div className="flex items-center gap-2 text-muted-foreground">
          <UploadIcon className="size-4" />
          <span>{t("drop")}</span>
        </div>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
          {t("browse")}
        </Button>
      </div>

      {stage.kind === "loading" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />…
        </p>
      )}
      {stage.kind === "error" && <p className="text-xs text-destructive">{stage.message}</p>}
      {stage.kind === "done" && (
        <p className="text-xs text-muted-foreground">
          {t("imported", { count: stage.importedCount })}
        </p>
      )}

      {stage.kind === "vsix-pick" && (
        <div className="space-y-2 rounded-md border p-3">
          <Label className="text-xs">{t("selectThemes")}</Label>
          <ul className="space-y-1">
            {stage.manifest.themes.map((entry, idx) => {
              const checked = stage.selected.has(idx)
              return (
                <li key={entry.path} className="flex items-center gap-2">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) => {
                      const next = new Set(stage.selected)
                      if (value) next.add(idx)
                      else next.delete(idx)
                      setStage({ ...stage, selected: next })
                    }}
                    aria-label={entry.label}
                  />
                  <span className="text-xs">{entry.label}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {entry.path}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="flex gap-2 pt-2">
            <Button
              size="sm"
              onClick={() => void finishVsix()}
              disabled={stage.selected.size === 0}
            >
              {t("importButton")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStage({ kind: "idle" })}>
              {t("cancelButton")}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs">{t("history")}</Label>
        {importedRecords.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noThemes")}</p>
        ) : (
          <ul className="space-y-1">
            {importedRecords.map((record) => {
              const ct = customThemes.find((c) => c.id === record.customThemeId)
              return (
                <li
                  key={record.customThemeId}
                  className="flex flex-col gap-1 rounded border p-2 text-xs sm:flex-row sm:items-center"
                >
                  <span className="font-medium">{ct?.name ?? record.sourceName}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {record.origin.kind === "json"
                      ? record.origin.fileName
                      : `${record.origin.vsixName} · ${record.origin.themePath}`}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto h-6 w-6 text-destructive"
                    onClick={() => void removeRecord(record)}
                    aria-label={t("removeButton")}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
