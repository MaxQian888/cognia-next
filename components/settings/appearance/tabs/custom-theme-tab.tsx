"use client"

// Edit the cognia ThemeColors palette directly. The user picks an existing
// theme (or "new"), tweaks tokens via `ColorTokenRow`, watches the
// `<ThemePreview />` update live, then saves. Saved themes are stored in
// `AppSettings.customThemes[]`; activation goes through
// `setActiveCustomTheme` so the rest of the app picks them up.
//
// Phase 5 / Task 18 wires four new affordances on top of the editor:
//   1. Per-card "Export" button — downloads the theme as a versioned
//      `*.cognia-theme.json` document.
//   2. Top-of-tab "Import theme JSON" button — hidden file input that
//      parses via `importThemeFromJson` and creates a new theme.
//   3. Per-row contrast chip — flags the eight critical foreground/
//      background pairs from `auditThemeContrast`.
//   4. Save warning dialog — confirms when audit failures are present.
// `handleSave` now writes the dual-variant `tokens.{light, dark}` shape
// directly (closing the TODO from the Task 7 follow-up commit `6ffc9a8`),
// keeping the legacy `colors`/`isDark` fields populated for the
// one-release rollback contract.

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
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
import { Trash2Icon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"
import { THEME_COLOR_KEYS, DEFAULT_FALLBACKS } from "@/lib/appearance"
import { auditThemeContrast, isFlaggedPair } from "@/lib/appearance/contrast-audit"
import { exportThemeToJson, importThemeFromJson } from "@/lib/appearance/theme-export"
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"
import { ColorTokenRow } from "../components/color-token-row"
import { ThemePreview } from "../components/theme-preview"
import { cn } from "@/lib/utils"

interface DraftTheme {
  id?: string
  name: string
  colors: Partial<ThemeColors>
  isDark: boolean
  /**
   * Snapshot of the previously-saved opposite-variant tokens, if the row
   * being edited already had `tokens.{opposite}`. Used at save time to
   * preserve the user's existing opposite side rather than re-deriving it
   * from the (just-edited) base side. Undefined for new drafts.
   */
  existingOpposite?: ThemeColors
}

// Stable empty fallback so the render-time reconciler below can use
// reference equality without thrashing when `customThemes` is undefined.
const EMPTY_THEMES: CustomTheme[] = []

function emptyDraft(isDark: boolean): DraftTheme {
  return {
    name: "",
    colors: { ...DEFAULT_FALLBACKS[isDark ? "dark" : "light"] },
    isDark,
  }
}

/**
 * Materialise a full ThemeColors palette from the (possibly partial) draft
 * colors, filling missing slots from the variant fallback. Used as input
 * to the contrast audit and as the base side of the dual-variant write.
 */
function fillTokens(partial: Partial<ThemeColors>, isDark: boolean): ThemeColors {
  const fallback = DEFAULT_FALLBACKS[isDark ? "dark" : "light"]
  const result = { ...fallback } as ThemeColors
  for (const key of THEME_COLOR_KEYS) {
    const v = partial[key]
    if (typeof v === "string" && v.length > 0) {
      result[key] = v
    }
  }
  return result
}

function buildDraftFromTheme(theme: CustomTheme): DraftTheme {
  // Phase 2: prefer the new dual-variant `tokens` shape; legacy rows
  // still ship a single `colors` set keyed by `isDark`.
  const variant = theme.baseVariant ?? (theme.isDark ? "dark" : "light")
  const sourceColors = theme.tokens?.[variant] ?? theme.colors ?? {}
  const opposite: "light" | "dark" = variant === "dark" ? "light" : "dark"
  return {
    id: theme.id,
    name: theme.name,
    colors: { ...sourceColors },
    isDark: variant === "dark",
    existingOpposite: theme.tokens?.[opposite],
  }
}

export function CustomThemeTab() {
  const t = useTranslations("settings.appearance.customTheme")
  const tokenT = useTranslations("settings.appearance.customTheme.tokens")

  const settings = useSettingsStore((s) => s.settings)
  const themes = settings?.customThemes ?? EMPTY_THEMES
  const activeId = settings?.activeCustomThemeId ?? null
  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)
  const updateCustomTheme = useSettingsStore((s) => s.updateCustomTheme)
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme)
  const setActive = useSettingsStore((s) => s.setActiveCustomTheme)

  const [draft, setDraft] = useState<DraftTheme>(() => emptyDraft(true))
  const [showSaveWarning, setShowSaveWarning] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  // Track the theme list reference we last reconciled with — when it
  // changes (e.g. an external save mutated the row we're editing), pull
  // the latest copy into the draft. Done during render to avoid the
  // setState-in-effect anti-pattern.
  const [reconciledThemes, setReconciledThemes] = useState(themes)
  if (themes !== reconciledThemes) {
    setReconciledThemes(themes)
    if (draft.id) {
      const found = themes.find((th) => th.id === draft.id)
      if (found) {
        setDraft(buildDraftFromTheme(found))
      }
    }
  }

  const fallback = DEFAULT_FALLBACKS[draft.isDark ? "dark" : "light"]
  const isExisting = Boolean(draft.id)

  // The audit consumes a fully-populated palette, so we materialise the
  // partial draft against the variant fallback. Memoised so per-row chips
  // don't re-run the eight WCAG comparisons on every keystroke when the
  // draft hasn't changed.
  const auditTokens = useMemo(
    () => fillTokens(draft.colors, draft.isDark),
    [draft.colors, draft.isDark]
  )
  const audit = useMemo(() => auditThemeContrast(auditTokens), [auditTokens])

  const handleSelect = (theme: CustomTheme) => {
    setDraft(buildDraftFromTheme(theme))
  }

  // Writes the dual-variant `tokens.{light, dark}` shape AND keeps the
  // legacy `colors`/`isDark` fields populated for the one-release rollback
  // contract documented in Decision 8 of ADR-0007. The opposite side is
  // preserved verbatim if the row already had it, otherwise derived from
  // the (just-edited) base side.
  const performSave = () => {
    if (!draft.name.trim()) return
    const baseVariant: "light" | "dark" = draft.isDark ? "dark" : "light"
    const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
    const editedTokens = fillTokens(draft.colors, draft.isDark)
    const oppositeTokens =
      draft.existingOpposite ?? deriveOppositeVariant(editedTokens, baseVariant)
    const tokens = {
      [baseVariant]: editedTokens,
      [opposite]: oppositeTokens,
    } as { light: ThemeColors; dark: ThemeColors }
    if (draft.id) {
      updateCustomTheme(draft.id, {
        name: draft.name.trim(),
        baseVariant,
        tokens,
        // Legacy fields kept one release for rollback safety.
        colors: draft.colors,
        isDark: draft.isDark,
      })
    } else {
      const newId = createCustomTheme({
        name: draft.name.trim(),
        baseVariant,
        tokens,
        colors: draft.colors,
        isDark: draft.isDark,
      })
      setDraft((d) => ({ ...d, id: newId, existingOpposite: oppositeTokens }))
    }
  }

  const handleSaveClick = () => {
    if (!draft.name.trim()) return
    if (audit.failureCount > 0) {
      setShowSaveWarning(true)
    } else {
      performSave()
    }
  }

  const handleConfirmSaveAnyway = () => {
    setShowSaveWarning(false)
    performSave()
  }

  const handleNew = () => setDraft(emptyDraft(true))
  const handleDelete = () => {
    if (!draft.id) return
    deleteCustomTheme(draft.id)
    setDraft(emptyDraft(true))
  }

  const handleActivate = () => {
    if (draft.id) void setActive(draft.id)
  }
  const handleDeactivate = () => {
    void setActive(null)
  }

  const handleExport = (theme: CustomTheme) => {
    try {
      const json = exportThemeToJson(theme)
      const blob = new Blob([json], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${theme.name.replace(/[^\w-]/g, "_") || "theme"}.cognia-theme.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(t("import.failure", { message: (err as Error).message }))
    }
  }

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const partial = importThemeFromJson(text)
      const id = createCustomTheme(partial as Omit<CustomTheme, "id">)
      void setActive(id)
      toast.success(t("import.success"))
    } catch (err) {
      toast.error(t("import.failure", { message: (err as Error).message }))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => importInputRef.current?.click()}>
            {t("actions.import")}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-testid="custom-theme-import-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleImportFile(f)
              e.target.value = ""
            }}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          placeholder={t("namePlaceholder")}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="h-8"
        />
        <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
          <Label className="text-xs">{t("darkLabel")}</Label>
          <Switch
            checked={draft.isDark}
            onCheckedChange={(v) => setDraft({ ...draft, isDark: v })}
            aria-label={t("darkLabel")}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleSaveClick} disabled={!draft.name.trim()}>
          {isExisting ? t("updateButton") : t("saveButton")}
        </Button>
        <Button size="sm" variant="outline" onClick={handleNew}>
          {t("newButton")}
        </Button>
        {isExisting && draft.id !== activeId && (
          <Button size="sm" variant="outline" onClick={handleActivate}>
            {t("activateButton")}
          </Button>
        )}
        {isExisting && draft.id === activeId && (
          <Button size="sm" variant="outline" onClick={handleDeactivate}>
            {t("deactivateButton")}
          </Button>
        )}
        {isExisting && (
          <Button size="sm" variant="destructive" onClick={handleDelete}>
            <Trash2Icon className="mr-1 size-3" />
            {t("deleteButton")}
          </Button>
        )}
        <div className="ml-auto">
          {audit.failureCount === 0 ? (
            <Badge variant="default">{t("audit.allPass")}</Badge>
          ) : (
            <Badge variant="destructive">
              {t("audit.failuresCount", {
                count: audit.failureCount,
                total: audit.totalPairs,
              })}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 rounded-md border p-3">
          {THEME_COLOR_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-2">
              <ColorTokenRow
                tokenKey={key}
                label={tokenT(key)}
                value={draft.colors[key] ?? fallback[key]}
                onChange={(next) =>
                  setDraft({ ...draft, colors: { ...draft.colors, [key]: next } })
                }
                className="flex-1"
                swatchAriaLabel={tokenT("aria.swatch", { label: tokenT(key) })}
                hexAriaLabel={tokenT("aria.hex", { label: tokenT(key) })}
              />
              {isFlaggedPair(audit, key) && (
                <Badge
                  variant="destructive"
                  className="shrink-0 text-[10px]"
                  data-testid={`audit-chip-${key}`}
                >
                  {t("audit.lowContrast")}
                </Badge>
              )}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <Label className="text-xs">{t("previewLabel")}</Label>
          <ThemePreview colors={draft.colors} fallback={fallback} />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("savedLabel")}</Label>
        {themes.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noSaved")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {themes.map((th) => {
              const active = th.id === activeId
              const editing = th.id === draft.id
              return (
                <div
                  key={th.id}
                  className={cn(
                    "flex items-center gap-1 rounded border px-2 py-1 text-xs transition",
                    editing ? "border-primary" : "border-border",
                    active && "bg-primary/10"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSelect(th)}
                    className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className="inline-block size-3 rounded-full border"
                      style={{
                        // Phase 2: read from the new `tokens` shape first;
                        // fall back to legacy `colors`.
                        background:
                          (th.baseVariant ?? (th.isDark ? "dark" : "light")) === "dark"
                            ? (th.tokens?.dark.primary ?? th.colors?.primary ?? "#888")
                            : (th.tokens?.light.primary ?? th.colors?.primary ?? "#888"),
                      }}
                    />
                    {th.name}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => handleExport(th)}
                    aria-label={`${t("actions.export")} ${th.name}`}
                  >
                    {t("actions.export")}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <AlertDialog open={showSaveWarning} onOpenChange={setShowSaveWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("audit.saveWarningTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("audit.saveWarningBody", { count: audit.failureCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("audit.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSaveAnyway}>
              {t("audit.saveAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
