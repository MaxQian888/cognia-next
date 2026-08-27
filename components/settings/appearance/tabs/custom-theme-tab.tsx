"use client"

// Edit the cognia ThemeColors palette directly. The user picks an existing
// theme (or "new"), tweaks tokens via the role-based `TokenGroup` clusters,
// watches the section's live preview update, then saves. Saved themes are
// stored in `AppSettings.customThemes[]`; activation goes through
// `setActiveCustomTheme` so the rest of the app picks them up.
//
// This editor owns no preview of its own: it publishes the draft to the one
// `AppearancePreview` the Appearance section mounts in its detail header (see
// `preview-draft-context.tsx`). Rendered outside that section the publish is
// inert and the editor still works.
//
// Two things changed shape here relative to the original editor:
//
//  1. **Both variants are editable.** The draft carries `tokens.light` *and*
//     `tokens.dark`, and a segmented control says which side the rows are
//     editing. Before, a single "dark variant" switch re-interpreted one set of
//     colours: flipping it did not load the other side, and at save time the
//     opposite variant was either preserved verbatim or overwritten wholesale
//     by `deriveOppositeVariant` — so a hand-tuned dark mode was unreachable.
//     Which variant a theme *defaults* to on activation is now its own control.
//
//  2. **The 27 tokens became 56.** Everything the app actually paints with —
//     status, charts, workflow nodes and statuses, the effort accent, the brand
//     triple — is editable. The 27 required tokens are always written on save;
//     the 29 optional ones are stored only when the user sets them, which is
//     what keeps a derived default (the running-workflow badge tracking
//     `warning`, the brand wash tracking `brandAction`) live across edits
//     instead of frozen at the value it happened to have.
//
// Interaction hardening carried over from the original editor:
//   1. Dirty-state protection — a `baseline` snapshot is kept for every draft
//      load point; switching themes / starting a new draft / duplicating while
//      dirty asks for confirmation instead of silently discarding edits.
//   2. Delete confirmation — both the action-row button and the rail's dropdown
//      route through an AlertDialog before `deleteCustomTheme`.
//   3. Duplicate — clones a saved row under a localised "(copy)" name and loads
//      the copy into the editor.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SearchIcon, Trash2Icon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import type { CustomTheme, ResolvedThemeColors, ThemeColors } from "@/types/plugin/plugin"
import {
  ADVANCED_THEME_COLOR_KEYS,
  BASE_THEME_COLOR_KEYS,
  THEME_COLOR_KEYS,
  normalizeThemeColors,
} from "@/lib/appearance"
import { auditThemeContrast } from "@/lib/appearance/contrast-audit"
import { exportThemeToJson, importThemeFromJson } from "@/lib/appearance/theme-export"
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"
import {
  DEFAULT_GROUP_OPEN,
  TOKEN_GROUPS,
  TokenGroup,
  type TokenGroupKey,
} from "../components/token-group"
import { SavedThemesRail } from "../components/saved-themes-rail"
import { usePreviewDraftPublisher } from "../preview-draft-context"

/**
 * Deep link naming the row to edit. `theme-tab`'s "edit a copy" sets it
 * alongside `appearanceTab=custom`; without it the copy was created, activated,
 * and then the editor opened on a blank new-theme draft, because nothing here
 * ever read which row the user had just asked for.
 */
const CUSTOM_THEME_ID_PARAM = "customThemeId"

type Variant = "light" | "dark"

interface DraftTheme {
  id?: string
  name: string
  /** Both sides, each sparse: an absent advanced key means "use the default". */
  tokens: Record<Variant, Partial<ThemeColors>>
  /** Which side the theme activates in when the app has no opinion. */
  baseVariant: Variant
}

/** Pending navigation that was intercepted by the dirty-draft guard. */
type PendingAction =
  | { type: "select"; theme: CustomTheme }
  | { type: "new" }
  | { type: "duplicate"; theme: CustomTheme }

// Stable empty fallback so the render-time reconciler below can use
// reference equality without thrashing when `customThemes` is undefined.
const EMPTY_THEMES: CustomTheme[] = []

const OTHER: Record<Variant, Variant> = { light: "dark", dark: "light" }

function emptyDraft(): DraftTheme {
  return { name: "", tokens: { light: {}, dark: {} }, baseVariant: "dark" }
}

/** Editable-field equality — drives the dirty check. */
function draftEquals(a: DraftTheme, b: DraftTheme): boolean {
  if (a.name !== b.name || a.baseVariant !== b.baseVariant) return false
  for (const variant of ["light", "dark"] as const) {
    for (const key of THEME_COLOR_KEYS) {
      if (a.tokens[variant][key] !== b.tokens[variant][key]) return false
    }
  }
  return true
}

function buildDraftFromTheme(theme: CustomTheme): DraftTheme {
  const baseVariant: Variant = theme.baseVariant ?? (theme.isDark ? "dark" : "light")
  if (theme.tokens?.light && theme.tokens?.dark) {
    return {
      id: theme.id,
      name: theme.name,
      tokens: { light: { ...theme.tokens.light }, dark: { ...theme.tokens.dark } },
      baseVariant,
    }
  }
  // Legacy single-set row: promote it once. Derived from the stored keys only,
  // so a row that never set a chart colour still doesn't claim to have one.
  const authored = { ...(theme.colors ?? {}) }
  const opposite = deriveOppositeVariant(authored as ThemeColors, baseVariant)
  return {
    id: theme.id,
    name: theme.name,
    tokens: {
      [baseVariant]: authored,
      [OTHER[baseVariant]]: opposite,
    } as Record<Variant, Partial<ThemeColors>>,
    baseVariant,
  }
}

/**
 * What actually gets persisted for one side.
 *
 * The 27 required tokens are materialised — every consumer, from the native
 * window chrome to the Pro IDE, expects them present. The 29 optional ones are
 * written only when the draft holds an explicit value, because an absent key is
 * what lets `normalizeThemeColors` keep re-deriving it: store a literal for
 * `workflowStatusRunning` and it stops following `warning` forever after.
 */
function tokensToPersist(draft: Partial<ThemeColors>, variant: Variant): ThemeColors {
  const resolved = normalizeThemeColors(draft, variant)
  const out: Partial<ThemeColors> = {}
  for (const key of BASE_THEME_COLOR_KEYS) out[key] = resolved[key]
  for (const key of ADVANCED_THEME_COLOR_KEYS) {
    const explicit = draft[key]
    if (typeof explicit === "string" && explicit.trim().length > 0) out[key] = explicit
  }
  return out as ThemeColors
}

export function CustomThemeTab() {
  const t = useTranslations("settings.appearance.customTheme")
  const tokenT = useTranslations("settings.appearance.customTheme.tokens")
  const router = useRouter()
  const searchParams = useSearchParams()

  const settings = useSettingsStore((s) => s.settings)
  const themes = settings?.customThemes ?? EMPTY_THEMES
  const activeId = settings?.activeCustomThemeId ?? null
  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)
  const updateCustomTheme = useSettingsStore((s) => s.updateCustomTheme)
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme)
  const setActive = useSettingsStore((s) => s.setActiveCustomTheme)

  const [draft, setDraft] = useState<DraftTheme>(emptyDraft)
  // Snapshot of the last loaded/saved draft — the dirty check compares against
  // this. Updated at every draft load point.
  const [baseline, setBaseline] = useState<DraftTheme>(emptyDraft)
  const [editing, setEditing] = useState<Variant>("dark")
  const [search, setSearch] = useState("")
  const [openGroups, setOpenGroups] = useState<Record<TokenGroupKey, boolean>>(() => ({
    ...DEFAULT_GROUP_OPEN,
  }))
  const [showSaveWarning, setShowSaveWarning] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  const isDirty = !draftEquals(draft, baseline)

  /** Load a draft and reset the dirty baseline in one step. */
  const applyDraft = (next: DraftTheme) => {
    setDraft(next)
    setBaseline(next)
    setEditing(next.baseVariant)
  }

  // --- URL-driven selection -------------------------------------------------
  //
  // Resolved during render (not in an effect) for the same reason the theme-list
  // reconciler below is: `components/settings/**` forbids set-state-in-effect,
  // and deferring by a frame would flash the blank new-theme draft first.
  const requestedId = searchParams.get(CUSTOM_THEME_ID_PARAM)
  const settingsLoaded = settings != null
  const requestedRow = requestedId ? themes.find((th) => th.id === requestedId) : undefined
  // The list has loaded and does not contain the row the link names — stale.
  const requestDangling = Boolean(requestedId && settingsLoaded && !requestedRow)
  const [handledRequestId, setHandledRequestId] = useState<string | null>(null)
  const [bootstrapped, setBootstrapped] = useState(false)
  const clearedRequestRef = useRef<string | null>(null)

  if (requestedRow && requestedId !== handledRequestId) {
    // An explicit deep link outranks an unsaved draft — the user just asked
    // for this row by clicking "edit a copy".
    setHandledRequestId(requestedId)
    setBootstrapped(true)
    const next = buildDraftFromTheme(requestedRow)
    setDraft(next)
    setBaseline(next)
    setEditing(next.baseVariant)
  }

  // No deep link: open whatever is currently applied, so the panel shows the
  // theme the user is looking at rather than an empty form.
  if (!bootstrapped && !requestedId && settingsLoaded) {
    setBootstrapped(true)
    const active = activeId ? themes.find((th) => th.id === activeId) : undefined
    if (active) {
      const next = buildDraftFromTheme(active)
      setDraft(next)
      setBaseline(next)
      setEditing(next.baseVariant)
    }
  }

  // Drop a stale param. A ref rather than state marks it done: this is
  // bookkeeping about a navigation that already happened, and setting state
  // from an effect would just schedule an extra render to say so.
  useEffect(() => {
    if (!requestDangling || !requestedId) return
    if (clearedRequestRef.current === requestedId) return
    clearedRequestRef.current = requestedId
    const next = new URLSearchParams(searchParams.toString())
    next.delete(CUSTOM_THEME_ID_PARAM)
    router.replace(`?${next.toString()}`, { scroll: false })
  }, [requestDangling, requestedId, router, searchParams])

  // Track the theme list reference we last reconciled with — when it changes
  // (e.g. an external save mutated the row we're editing), pull the latest copy
  // into the draft. Done during render to avoid the setState-in-effect
  // anti-pattern. Skipped while the draft is dirty so rail actions on *other*
  // rows (activate / duplicate / delete) never clobber in-progress edits.
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

  const isExisting = Boolean(draft.id)

  // Both the audit and the section's preview consume a fully-populated palette,
  // so we resolve the sparse draft. Memoised so per-row chips don't re-run the
  // WCAG comparisons on every keystroke when nothing changed.
  const resolvedLight = useMemo(
    () => normalizeThemeColors(draft.tokens.light, "light"),
    [draft.tokens.light]
  )
  const resolvedDark = useMemo(
    () => normalizeThemeColors(draft.tokens.dark, "dark"),
    [draft.tokens.dark]
  )
  const resolvedByVariant: Record<Variant, ResolvedThemeColors> = useMemo(
    () => ({ light: resolvedLight, dark: resolvedDark }),
    [resolvedLight, resolvedDark]
  )
  const auditLight = useMemo(() => auditThemeContrast(resolvedLight), [resolvedLight])
  const auditDark = useMemo(() => auditThemeContrast(resolvedDark), [resolvedDark])
  const auditByVariant = useMemo(
    () => ({ light: auditLight, dark: auditDark }),
    [auditLight, auditDark]
  )
  const audit = auditByVariant[editing]
  // Save warns on the whole theme, not just the side on screen — a clean light
  // variant should not hide a dark one that fails.
  const totalFailures = auditLight.failureCount + auditDark.failureCount

  // Drive the section's single preview off the draft, and hand it back when
  // this panel unmounts. Keying off committed state covers every mutation path
  // — event handlers and the render-phase reconcilers alike.
  const publishDraft = usePreviewDraftPublisher()
  useEffect(() => {
    publishDraft({ colors: resolvedByVariant[editing], isDark: editing === "dark" })
    return () => publishDraft(null)
  }, [resolvedByVariant, editing, publishDraft])

  // --- token search ---------------------------------------------------------
  const query = search.trim().toLowerCase()
  const visibleGroups = useMemo(() => {
    if (!query) return TOKEN_GROUPS.map((g) => ({ ...g, tokens: [...g.tokens] }))
    return TOKEN_GROUPS.map((group) => ({
      ...group,
      tokens: group.tokens.filter(
        (key) => key.toLowerCase().includes(query) || tokenT(key).toLowerCase().includes(query)
      ),
    })).filter((group) => group.tokens.length > 0)
  }, [query, tokenT])
  const matchCount = useMemo(
    () => visibleGroups.reduce((n, g) => n + g.tokens.length, 0),
    [visibleGroups]
  )

  const setToken = (key: keyof ThemeColors, next: string) =>
    setDraft((prev) => ({
      ...prev,
      tokens: { ...prev.tokens, [editing]: { ...prev.tokens[editing], [key]: next } },
    }))

  const resetToken = (key: keyof ThemeColors) =>
    setDraft((prev) => {
      const side = { ...prev.tokens[editing] }
      delete side[key]
      return { ...prev, tokens: { ...prev.tokens, [editing]: side } }
    })

  const doSelect = (theme: CustomTheme) => applyDraft(buildDraftFromTheme(theme))

  const doNew = () => applyDraft(emptyDraft())

  const doDuplicate = (theme: CustomTheme) => {
    const source = buildDraftFromTheme(theme)
    const copy: Omit<CustomTheme, "id"> = {
      name: t("rail.copySuffix", { name: theme.name }),
      baseVariant: source.baseVariant,
      tokens: {
        light: tokensToPersist(source.tokens.light, "light"),
        dark: tokensToPersist(source.tokens.dark, "dark"),
      },
      isDark: source.baseVariant === "dark",
      colors: source.tokens[source.baseVariant],
      // Carried so a copy of a plugin-derived row renders identically to the
      // row it came from — these used to be dropped here while `handleEditCopy`
      // preserved them, so duplicating a clone silently lost its extra CSS.
      cssVars: theme.cssVars,
      sourcePluginId: theme.sourcePluginId,
      sourceBuiltinName: theme.sourceBuiltinName,
    }
    const id = createCustomTheme(copy)
    applyDraft({ ...source, id, name: copy.name })
  }

  // Dirty-guarded entry points — intercept with the discard dialog when the
  // draft has unsaved edits.
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

  // Writes both variants and clears `derivedVariant`: once a theme has been
  // through this editor, neither side is an algorithm's guess any more. The
  // legacy `colors`/`isDark` fields stay populated for the one-release rollback
  // contract documented in Decision 8 of ADR-0007.
  const performSave = () => {
    if (!draft.name.trim()) return
    const tokens = {
      light: tokensToPersist(draft.tokens.light, "light"),
      dark: tokensToPersist(draft.tokens.dark, "dark"),
    }
    const patch = {
      name: draft.name.trim(),
      baseVariant: draft.baseVariant,
      derivedVariant: undefined,
      tokens,
      colors: draft.tokens[draft.baseVariant],
      isDark: draft.baseVariant === "dark",
    }
    if (draft.id) {
      updateCustomTheme(draft.id, patch)
      setBaseline(draft)
    } else {
      const newId = createCustomTheme(patch)
      const saved = { ...draft, id: newId, name: patch.name }
      setDraft(saved)
      setBaseline(saved)
    }
  }

  const handleSaveClick = () => {
    if (!draft.name.trim()) return
    if (totalFailures > 0) {
      setShowSaveWarning(true)
    } else {
      performSave()
    }
  }

  const handleConfirmSaveAnyway = () => {
    setShowSaveWarning(false)
    performSave()
  }

  // Deletion always routes through the confirm dialog — from the action row
  // (current draft) or from the rail's per-item dropdown (any row).
  const requestDelete = (id: string, name: string) => setDeleteTarget({ id, name })

  const handleConfirmDelete = () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    deleteCustomTheme(target.id)
    if (target.id === draft.id) {
      applyDraft(emptyDraft())
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

  const groupOpen = useCallback(
    (key: TokenGroupKey) => (query ? true : openGroups[key]),
    [query, openGroups]
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => importInputRef.current?.click()}>
            {t("actions.import")}
          </Button>
          <Input
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

      {/* Container-, not viewport-driven: this editor lives in the section's
          ~700px detail pane, so a viewport breakpoint would split the columns
          while the pane is far too narrow for them (it squeezed the hex inputs
          to 26px). Only split once the pane itself can afford it. */}
      <div className="grid gap-4 @4xl/appearance-pane:grid-cols-[minmax(0,1fr)_320px]">
        {/* Editor column */}
        <div className="space-y-4">
          <div className="grid gap-3 @xl/appearance-pane:grid-cols-2">
            <Input
              placeholder={t("namePlaceholder")}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="h-8"
            />
            <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
              <Label className="text-xs" htmlFor="custom-theme-default-variant">
                {t("defaultVariant.label")}
              </Label>
              <Select
                value={draft.baseVariant}
                onValueChange={(v) => setDraft({ ...draft, baseVariant: v as Variant })}
              >
                <SelectTrigger
                  id="custom-theme-default-variant"
                  size="sm"
                  className="h-6 w-24"
                  data-testid="custom-theme-default-variant"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">{t("variant.light")}</SelectItem>
                  <SelectItem value="dark">{t("variant.dark")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Which side the rows below edit. Separate from the default-variant
              control above: "the palette I'm painting right now" and "the side
              this theme opens in" are different questions, and collapsing them
              into one switch is what made the dark variant unreachable. */}
          <div
            className="flex items-center gap-2 rounded-md border bg-muted/30 p-1"
            role="group"
            aria-label={t("variant.editingLabel")}
          >
            {(["light", "dark"] as const).map((variant) => (
              <Button
                key={variant}
                size="sm"
                variant={editing === variant ? "default" : "ghost"}
                className="h-7 flex-1 text-xs"
                aria-pressed={editing === variant}
                onClick={() => setEditing(variant)}
                data-testid={`custom-theme-edit-${variant}`}
              >
                {t(`variant.${variant}`)}
                {auditByVariant[variant].failureCount > 0 && (
                  <Badge variant="destructive" className="ml-1 text-[10px]">
                    {auditByVariant[variant].failureCount}
                  </Badge>
                )}
              </Button>
            ))}
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
              {totalFailures === 0 ? (
                <Badge variant="default">{t("audit.allPass")}</Badge>
              ) : (
                <Badge variant="destructive" data-testid="custom-theme-audit-summary">
                  {t("audit.failuresBothVariants", {
                    count: totalFailures,
                    total: audit.totalPairs * 2,
                  })}
                </Badge>
              )}
            </div>
          </div>

          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("search.placeholder")}
              aria-label={t("search.ariaLabel")}
              className="h-8 pl-7"
              data-testid="custom-theme-token-search"
            />
          </div>

          <div className="space-y-2">
            {query && matchCount === 0 && (
              <p
                className="px-1 py-4 text-xs text-muted-foreground"
                data-testid="token-search-empty"
              >
                {t("search.noResults", { query: search.trim() })}
              </p>
            )}
            {visibleGroups.map((group) => (
              <TokenGroup
                key={group.key}
                groupKey={group.key}
                label={t(`groups.${group.key}`)}
                tokens={group.tokens}
                defaultOpen={DEFAULT_GROUP_OPEN[group.key]}
                open={groupOpen(group.key)}
                onOpenChange={(next) => setOpenGroups((prev) => ({ ...prev, [group.key]: next }))}
                values={draft.tokens[editing]}
                fallback={resolvedByVariant[editing]}
                audit={audit}
                tokenLabel={(key) => tokenT(key)}
                swatchAriaLabel={(key) => tokenT("aria.swatch", { label: tokenT(key) })}
                hexAriaLabel={(key) => tokenT("aria.hex", { label: tokenT(key) })}
                auditChipLabel={t("audit.lowContrast")}
                failureBadgeLabel={(count) => t("groupFailures", { count })}
                onChange={setToken}
                onReset={resetToken}
                resetLabel={t("resetToken")}
              />
            ))}
          </div>
        </div>

        {/* Saved-themes column (sticky on xl so the rail stays reachable while
            scrolling through token groups) */}
        <div className="space-y-4 @4xl/appearance-pane:sticky @4xl/appearance-pane:top-4 @4xl/appearance-pane:self-start">
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
              {t("audit.saveWarningBody", { count: totalFailures })}
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
