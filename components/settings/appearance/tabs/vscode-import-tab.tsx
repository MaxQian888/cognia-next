"use client"

// VSCode color theme importer. Two paths:
//   .json  → parsed directly, lands as a single CustomTheme.
//   .vsix  → unzipped, the user picks which contributed themes to import.
// Imported themes go through the existing `createCustomTheme` flow so the
// rest of the appearance pipeline (preview, activate, edit) gets them
// automatically. We also append an `ImportedThemeRecord` to keep
// provenance for the UI.

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Loader2Icon, Trash2Icon, UploadIcon } from "lucide-react"
import {
  importVscodeThemeJson,
  readVsix,
  type ParsedTheme,
  type VsixManifest,
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
  | { kind: "done"; importedCount: number }

/**
 * Hard ceiling on the parse phase. JSZip on a sufficiently large or
 * malformed buffer can hang without ever rejecting; without this the
 * spinner stays on forever and the user has no way to recover except
 * reloading the page. 30 s is comfortably more than a normal 10 MB
 * VSIX needs (sub-second on a laptop) but short enough that a hang is
 * obvious.
 */
const PARSE_TIMEOUT_MS = 30_000

export function VscodeImportTab() {
  const t = useTranslations("settings.appearance.vscode")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  // Top-level error surfaced via a destructive Alert. Lives outside
  // `Stage` so it survives the loading → vsix-pick transition and so
  // the picker can also write to it (a per-theme failure during the
  // commit loop must be visible without losing the picker context).
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)
  const setActive = useSettingsStore((s) => s.setActiveCustomTheme)
  const addImportedTheme = useSettingsStore((s) => s.addImportedTheme)
  const removeImportedTheme = useSettingsStore((s) => s.removeImportedTheme)
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme)
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const importedRecords = useSettingsStore(
    (s) => s.settings?.importedVscodeThemes ?? EMPTY_IMPORTED
  )
  const customThemes = useSettingsStore((s) => s.settings?.customThemes ?? EMPTY_CUSTOM_THEMES)

  const handleFile = async (file: File) => {
    setStage({ kind: "loading" })
    setError(null)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setError(t("timeout"))
      setStage({ kind: "idle" })
    }, PARSE_TIMEOUT_MS)
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
      setError((err as Error).message)
      setStage({ kind: "idle" })
    } finally {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
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
    setError(null)
    try {
      let imported = 0
      let lastId: string | null = null
      for (let idx = 0; idx < manifest.themes.length; idx += 1) {
        if (!selected.has(idx)) continue
        const entry = manifest.themes[idx]
        // `entry.parsed` is populated eagerly by `readVsix` — no zip
        // closure to GC out from under us, no async work per pick.
        const id = await commitTheme(entry.parsed, {
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
      setError((err as Error).message)
      setStage({ kind: "idle" })
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

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("errorTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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
