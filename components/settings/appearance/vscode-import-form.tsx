"use client"

// Reusable VSCode color theme import form. Same drop-zone / file-picker /
// vsix-picker flow that lives inline in `vscode-import-tab.tsx`, but
// extracted so the Theme tab header can also trigger it (rendered inside
// a dialog by `vscode-import-dialog.tsx`). The history list stays in
// `vscode-import-tab.tsx` — that's tab-specific.

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Loader2Icon, UploadIcon } from "lucide-react"
import {
  importVscodeThemeJson,
  readVsix,
  type ParsedTheme,
  type VsixManifest,
} from "@/lib/appearance"
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"
import { useSettingsStore } from "@/stores/settings"
import { importedThemeSourceKey, type ImportedThemeRecord } from "@/types/appearance"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { cn } from "@/lib/utils"

type Stage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "vsix-pick"; manifest: VsixManifest; selected: Set<number>; vsixName: string }
  | { kind: "done"; importedCount: number }

const PARSE_TIMEOUT_MS = 30_000

export interface VscodeImportFormProps {
  /**
   * Optional callback fired after a successful import. Used by the dialog
   * surface to auto-close. The tab surface omits this so the form stays
   * open and the user can keep importing.
   */
  onComplete?: (importedCount: number) => void
  /** Whether to show the description blurb. Defaults to true. */
  showDescription?: boolean
}

export function VscodeImportForm({ onComplete, showDescription = true }: VscodeImportFormProps) {
  const t = useTranslations("settings.appearance.vscode")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)
  const updateCustomTheme = useSettingsStore((s) => s.updateCustomTheme)
  const setActive = useSettingsStore((s) => s.setActiveCustomTheme)
  const addImportedTheme = useSettingsStore((s) => s.addImportedTheme)
  const importedRecords = useSettingsStore((s) => s.settings?.importedVscodeThemes)

  const commitTheme = async (
    parsed: ParsedTheme,
    origin: ImportedThemeRecord["origin"]
  ): Promise<string> => {
    const baseVariant: "light" | "dark" = parsed.theme.isDark ? "dark" : "light"
    const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
    const tokens = {
      [baseVariant]: parsed.theme.colors,
      [opposite]: deriveOppositeVariant(parsed.theme.colors, baseVariant),
    } as { light: ThemeColors; dark: ThemeColors }
    const seed = {
      name: parsed.theme.name,
      baseVariant,
      derivedVariant: opposite,
      tokens,
      isDark: parsed.theme.isDark,
      colors: parsed.theme.colors,
    }

    // Re-importing the same source key (same .vsix entry, same .json file)
    // updates the existing CustomTheme + ImportedThemeRecord in place
    // instead of piling up duplicates in History.
    const sourceKey = importedThemeSourceKey(origin, parsed.theme.name)
    const existingRecord = (importedRecords ?? []).find((r) => r.sourceKey === sourceKey)
    const existingId = existingRecord?.customThemeId
    if (existingId) {
      updateCustomTheme(existingId, seed)
    }
    const finalId = existingId ?? createCustomTheme(seed)
    await addImportedTheme({
      customThemeId: finalId,
      sourceKey,
      sourceName: parsed.theme.name,
      sourceVariant: parsed.theme.isDark ? "dark" : "light",
      importedAt: Date.now(),
      origin,
    })
    return finalId
  }

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
          selected: new Set(manifest.themes.map((_, idx) => idx)),
          vsixName: file.name,
        })
        return
      }
      const text = await file.text()
      const parsed = importVscodeThemeJson(text)
      const id = await commitTheme(parsed, {
        kind: "json",
        fileName: file.name,
      })
      await setActive(id)
      setStage({ kind: "done", importedCount: 1 })
      onComplete?.(1)
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
      onComplete?.(imported)
    } catch (err) {
      setError((err as Error).message)
      setStage({ kind: "idle" })
    }
  }

  return (
    <div className="space-y-4">
      {showDescription && <p className="text-xs text-muted-foreground">{t("description")}</p>}

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
    </div>
  )
}
