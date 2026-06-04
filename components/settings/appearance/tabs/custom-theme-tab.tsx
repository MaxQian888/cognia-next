"use client"

// Edit the cognia ThemeColors palette directly. The user picks an existing
// theme (or "new"), tweaks tokens via the role-based `TokenGroup` clusters,
// watches the `<ThemePreview />` update live, then saves. Saved themes are
// stored in `AppSettings.customThemes[]`; activation goes through
// `setActiveCustomTheme` so the rest of the app picks them up.
//
// Layout: xl+ renders two columns — the editor (name / dark switch /
// action row / five collapsible token groups) on the left, and a sticky
// column with the live preview plus the `SavedThemesRail` on the right.
// Below xl everything stacks into a single column and the rail becomes a
// wrapping horizontal strip (handled inside the rail component).
//
// Interaction hardening on top of the original editor:
//   1. Dirty-state protection — a `baseline` snapshot is kept for every
//      draft load point; switching themes / starting a new draft /
//      duplicating while dirty asks for confirmation instead of silently
//      discarding edits.
//   2. Delete confirmation — both the action-row button and the rail's
//      dropdown route through an AlertDialog before `deleteCustomTheme`.
//   3. Duplicate — clones a saved row (tokens + legacy fields) under a
//      localised "(copy)" name and loads the copy into the editor.
// `handleSave` writes the dual-variant `tokens.{light, dark}` shape while
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
import { auditThemeContrast } from "@/lib/appearance/contrast-audit"
import { exportThemeToJson, importThemeFromJson } from "@/lib/appearance/theme-export"
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"
import { DEFAULT_GROUP_OPEN, TOKEN_GROUPS, TokenGroup } from "../components/token-group"
import { SavedThemesRail } from "../components/saved-themes-rail"
import { ThemePreview } from "../components/theme-preview"

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

/** Pending navigation that was intercepted by the dirty-draft guard. */
type PendingAction =
  | { type: "select"; theme: CustomTheme }
  | { type: "new" }
  | { type: "duplicate"; theme: CustomTheme }

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

/** Editable-field equality — drives the dirty check. `existingOpposite` is
 * save-time metadata, not user input, so it's deliberately excluded. */
function draftEquals(a: DraftTheme, b: DraftTheme): boolean {
  if (a.name !== b.name || a.isDark !== b.isDark) return false
  for (const key of THEME_COLOR_KEYS) {
    if (a.colors[key] !== b.colors[key]) return false
  }
  return true
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
  // Snapshot of the last loaded/saved draft — the dirty check compares
  // against this. Updated at every draft load point (select / new / save /
  // duplicate / reconciler rebuild).
  const [baseline, setBaseline] = useState<DraftTheme>(() => emptyDraft(true))
  const [showSaveWarning, setShowSaveWarning] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  const isDirty = !draftEquals(draft, baseline)

  /** Load a draft and reset the dirty baseline in one step. */
  const applyDraft = (next: DraftTheme) => {
    setDraft(next)
    setBaseline(next)
  }

  // Track the theme list reference we last reconciled with — when it
  // changes (e.g. an external save mutated the row we're editing), pull
  // the latest copy into the draft. Done during render to avoid the
  // setState-in-effect anti-pattern. Skipped while the draft is dirty so
  // rail actions on *other* rows (activate / duplicate / delete) never
  // clobber in-progress edits.
  const [reconciledThemes, setReconciledThemes] = useState(themes)
  if (themes !== reconciledThemes) {
    setReconciledThemes(themes)
    if (draft.id && !isDirty) {
      const found = themes.find((th) => th.id === draft.id)
      if (found) {
        const next = buildDraftFromTheme(found)
        setDraft(next)
        setBaseline(next)
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

  const doSelect = (theme: CustomTheme) => {
    applyDraft(buildDraftFromTheme(theme))
  }

  const doNew = () => applyDraft(emptyDraft(true))

  const doDuplicate = (theme: CustomTheme) => {
    const copy: Omit<CustomTheme, "id"> = {
      name: t("rail.copySuffix", { name: theme.name }),
      baseVariant: theme.baseVariant,
      tokens: theme.tokens,
      colors: theme.colors,
      isDark: theme.isDark,
    }
    const id = createCustomTheme(copy)
    applyDraft(buildDraftFromTheme({ ...copy, id }))
  }

  // Dirty-guarded entry points — intercept with the discard dialog when
  // the draft has unsaved edits.
  const guard = (action: PendingAction, run: () => void) => {
    if (isDirty) {
      setPendingAction(action)
    } else {
      run()
    }
  }
  const handleSelect = (theme: CustomTheme) =>
    guard({ type: "select", theme }, () => doSelect(theme))
  const handleNew = () => guard({ type: "new" }, doNew)
  const handleDuplicate = (theme: CustomTheme) =>
    guard({ type: "duplicate", theme }, () => doDuplicate(theme))

  const handleConfirmDiscard = () => {
    const action = pendingAction
    setPendingAction(null)
    if (!action) return
    if (action.type === "select") doSelect(action.theme)
    else if (action.type === "new") doNew()
    else doDuplicate(action.theme)
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
      applyDraft({ ...draft, existingOpposite: oppositeTokens })
    } else {
      const newId = createCustomTheme({
        name: draft.name.trim(),
        baseVariant,
        tokens,
        colors: draft.colors,
        isDark: draft.isDark,
      })
      applyDraft({ ...draft, id: newId, existingOpposite: oppositeTokens })
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

  // Deletion always routes through the confirm dialog — from the action
  // row (current draft) or from the rail's per-item dropdown (any row).
  const requestDelete = (id: string, name: string) => setDeleteTarget({ id, name })

  const handleConfirmDelete = () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    deleteCustomTheme(target.id)
    if (target.id === draft.id) {
      applyDraft(emptyDraft(true))
    }
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Editor column */}
        <div className="space-y-4">
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
            <Button size="sm" variant="outline" onClick={handleNew} data-testid="custom-theme-new">
              {t("newButton")}
            </Button>
            {isExisting && draft.id !== activeId && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleActivate}
                data-testid="custom-theme-activate"
              >
                {t("activateButton")}
              </Button>
            )}
            {isExisting && draft.id === activeId && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleDeactivate}
                data-testid="custom-theme-deactivate"
              >
                {t("deactivateButton")}
              </Button>
            )}
            {isExisting && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => draft.id && requestDelete(draft.id, draft.name)}
                data-testid="custom-theme-delete"
              >
                <Trash2Icon className="mr-1 size-3" />
                {t("deleteButton")}
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {isDirty && (
                <Badge variant="secondary" data-testid="custom-theme-unsaved">
                  {t("unsavedBadge")}
                </Badge>
              )}
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

          <div className="space-y-2">
            {TOKEN_GROUPS.map((group) => (
              <TokenGroup
                key={group.key}
                groupKey={group.key}
                label={t(`groups.${group.key}`)}
                tokens={group.tokens}
                defaultOpen={DEFAULT_GROUP_OPEN[group.key]}
                values={draft.colors}
                fallback={fallback}
                audit={audit}
                tokenLabel={(key) => tokenT(key)}
                swatchAriaLabel={(key) => tokenT("aria.swatch", { label: tokenT(key) })}
                hexAriaLabel={(key) => tokenT("aria.hex", { label: tokenT(key) })}
                auditChipLabel={t("audit.lowContrast")}
                failureBadgeLabel={(count) => t("groupFailures", { count })}
                onChange={(key, next) =>
                  setDraft({ ...draft, colors: { ...draft.colors, [key]: next } })
                }
              />
            ))}
          </div>
        </div>

        {/* Preview + saved-themes column (sticky on xl so the preview stays
            visible while scrolling through token groups) */}
        <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div className="space-y-2">
            <Label className="text-xs">{t("previewLabel")}</Label>
            <ThemePreview colors={draft.colors} fallback={fallback} />
          </div>
          <SavedThemesRail
            themes={themes}
            activeId={activeId}
            editingId={draft.id}
            labels={{
              title: t("savedLabel"),
              empty: t("noSaved"),
              startNew: t("newButton"),
              activate: t("activateButton"),
              deactivate: t("deactivateButton"),
              duplicate: t("rail.duplicate"),
              export: t("actions.export"),
              delete: t("deleteButton"),
              more: t("rail.more"),
              lightSwatchAria: t("rail.lightSwatchAria"),
              darkSwatchAria: t("rail.darkSwatchAria"),
              activeBadgeAria: t("rail.activeBadgeAria"),
            }}
            onSelect={handleSelect}
            onActivate={(id) => void setActive(id)}
            onDeactivate={handleDeactivate}
            onDuplicate={handleDuplicate}
            onExport={handleExport}
            onDelete={(id) => {
              const th = themes.find((item) => item.id === id)
              requestDelete(id, th?.name ?? "")
            }}
            onNew={handleNew}
          />
        </div>
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

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("discardDialog.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("discardDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDiscard}>
              {t("discardDialog.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDialog.body", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("deleteDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              {t("deleteDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
