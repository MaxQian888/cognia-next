"use client"

// Edit the cognia ThemeColors palette directly. The user picks an existing
// theme (or "new"), tweaks tokens via `ColorTokenRow`, watches the
// `<ThemePreview />` update live, then saves. Saved themes are stored in
// `AppSettings.customThemes[]`; activation goes through
// `setActiveCustomTheme` so the rest of the app picks them up.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Trash2Icon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"
import { THEME_COLOR_KEYS, DEFAULT_FALLBACKS } from "@/lib/appearance"
import { ColorTokenRow } from "../components/color-token-row"
import { ThemePreview } from "../components/theme-preview"
import { cn } from "@/lib/utils"

interface DraftTheme {
  id?: string
  name: string
  colors: Partial<ThemeColors>
  isDark: boolean
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
        // Phase 2: prefer the new dual-variant `tokens` shape; fall back
        // to legacy single `colors` for unmigrated rows.
        const variant = found.baseVariant ?? (found.isDark ? "dark" : "light")
        const sourceColors = found.tokens?.[variant] ?? found.colors ?? {}
        setDraft({
          id: found.id,
          name: found.name,
          colors: { ...sourceColors },
          isDark: variant === "dark",
        })
      }
    }
  }

  const fallback = DEFAULT_FALLBACKS[draft.isDark ? "dark" : "light"]
  const isExisting = Boolean(draft.id)

  const handleSelect = (theme: CustomTheme) => {
    // Phase 2: prefer the new dual-variant `tokens` shape; legacy rows
    // still ship a single `colors` set keyed by `isDark`.
    const variant = theme.baseVariant ?? (theme.isDark ? "dark" : "light")
    const sourceColors = theme.tokens?.[variant] ?? theme.colors ?? {}
    setDraft({
      id: theme.id,
      name: theme.name,
      colors: { ...sourceColors },
      isDark: variant === "dark",
    })
  }

  const handleSave = () => {
    if (!draft.name.trim()) return
    if (draft.id) {
      updateCustomTheme(draft.id, {
        name: draft.name.trim(),
        colors: draft.colors,
        isDark: draft.isDark,
      })
    } else {
      const newId = createCustomTheme({
        name: draft.name.trim(),
        colors: draft.colors,
        isDark: draft.isDark,
      })
      setDraft((d) => ({ ...d, id: newId }))
    }
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

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
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

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleSave} disabled={!draft.name.trim()}>
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
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 rounded-md border p-3">
          {THEME_COLOR_KEYS.map((key) => (
            <ColorTokenRow
              key={key}
              tokenKey={key}
              label={tokenT(key)}
              value={draft.colors[key] ?? fallback[key]}
              onChange={(next) => setDraft({ ...draft, colors: { ...draft.colors, [key]: next } })}
            />
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
                <button
                  key={th.id}
                  type="button"
                  onClick={() => handleSelect(th)}
                  className={cn(
                    "flex items-center gap-2 rounded border px-2 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    editing ? "border-primary" : "border-border hover:border-foreground/30",
                    active && "bg-primary/10"
                  )}
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
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
