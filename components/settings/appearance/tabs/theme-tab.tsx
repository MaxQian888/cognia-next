"use client"

// Theme + color preset selection. Three vertical sections:
//   1. 明暗模式 — light / dark / system radio.
//   2. 颜色预设 — 8 color preset chips.
//   3. VSCode 预设 — single grid merging built-in, imported, and plugin
//      themes. Plugin themes flow in via `theme-registry` (subscribed via
//      `useSyncExternalStore`); activating any non-imported card seeds a
//      persistent CustomTheme so the choice survives plugin disable.

import { useDeferredValue, useMemo, useState, useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { UploadIcon } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSettingsStore } from "@/stores/settings"
import type { AppTheme } from "@/lib/claude/types"
import type { ColorThemePreset, CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"
import { COLOR_PRESETS } from "@/lib/themes"
import { BUILT_IN_VSCODE_THEMES } from "@/lib/appearance/built-in-vscode-themes"
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"
import {
  listPluginThemes,
  subscribeThemeRegistry,
  type PluginTheme,
} from "@/lib/theme/theme-registry"
import { cn } from "@/lib/utils"
import { PresetGrid, type PresetItem } from "./preset-grid"
import { VscodeImportDialog } from "../vscode-import-dialog"

const PRESET_SWATCHES: Record<ColorThemePreset, { light: string; dark: string }> = {
  default: { light: "#3b82f6", dark: "#60a5fa" },
  ocean: { light: "#0284c7", dark: "#38bdf8" },
  forest: { light: "#16a34a", dark: "#4ade80" },
  sunset: { light: "#ea580c", dark: "#fb923c" },
  lavender: { light: "#7c3aed", dark: "#a78bfa" },
  rose: { light: "#e11d48", dark: "#fb7185" },
  slate: { light: "#475569", dark: "#94a3b8" },
  amber: { light: "#d97706", dark: "#fbbf24" },
}

// Stable empty fallback — same rationale as `vscode-import-tab.tsx`.
const EMPTY_PLUGIN_THEMES: PluginTheme[] = []
function getServerPluginThemes(): PluginTheme[] {
  return EMPTY_PLUGIN_THEMES
}

type VariantFilter = "all" | "light" | "dark"

export function ThemeTab() {
  const t = useTranslations("settings.appearance")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const setActiveCustom = useSettingsStore((s) => s.setActiveCustomTheme)
  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)
  const { setTheme } = useTheme()
  const theme: AppTheme = settings?.theme ?? "system"
  const colorTheme: ColorThemePreset = settings?.colorTheme ?? "default"
  const activeCustomThemeId = settings?.activeCustomThemeId ?? null
  const customThemes = settings?.customThemes ?? []
  const importedRecords = settings?.importedVscodeThemes ?? []
  const router = useRouter()
  const searchParams = useSearchParams()

  // Subscribe to the in-memory plugin theme registry. The registry returns
  // a stable array reference between mutations, so `useSyncExternalStore`
  // doesn't loop.
  const pluginThemes = useSyncExternalStore(
    subscribeThemeRegistry,
    listPluginThemes,
    getServerPluginThemes
  )

  // ── VSCode presets: unified list ───────────────────────────────────────
  // Build one array spanning all three sources. Map-based dedupe so plugin
  // themes can't shadow a built-in by accident — first writer wins.
  const vscodePresets: PresetItem[] = useMemo(() => {
    const out = new Map<string, PresetItem>()

    for (const preset of BUILT_IN_VSCODE_THEMES) {
      const variant: "light" | "dark" = preset.baseVariant ?? (preset.isDark ? "dark" : "light")
      const colors = preset.tokens?.[variant] ?? (preset.colors as ThemeColors | undefined)
      if (!colors) continue
      const key = `builtin:${preset.name}`
      out.set(key, {
        key,
        name: preset.name,
        colors,
        isDark: variant === "dark",
        source: "builtin",
      })
    }

    for (const record of importedRecords) {
      const ct = customThemes.find((c) => c.id === record.customThemeId)
      if (!ct) continue
      const variant = ct.baseVariant ?? (ct.isDark ? "dark" : "light")
      const colors = ct.tokens?.[variant] ?? (ct.colors as ThemeColors | undefined)
      if (!colors) continue
      const key = `imported:${record.customThemeId}`
      if (out.has(key)) continue
      out.set(key, {
        key,
        name: ct.name,
        colors,
        isDark: variant === "dark",
        source: "imported",
        customThemeId: record.customThemeId,
      })
    }

    for (const pt of pluginThemes) {
      if (!pt.colors) continue
      const key = `plugin:${pt.id}`
      if (out.has(key)) continue
      out.set(key, {
        key,
        name: pt.name,
        colors: pt.colors,
        isDark: pt.isDark === true,
        source: "plugin",
        pluginId: pt.pluginId,
        pluginName: pt.pluginName ?? pt.pluginId,
      })
    }

    return Array.from(out.values())
  }, [importedRecords, customThemes, pluginThemes])

  // ── Active key ─────────────────────────────────────────────────────────
  // Imported cards match by customThemeId; plugin cards by sourcePluginId +
  // name; built-in cards prefer the explicit `sourceBuiltinName` stamp set
  // by handleSelect, falling back to a plain name match for clones written
  // before that field existed.
  const activeKey: string | null = useMemo(() => {
    if (!activeCustomThemeId) return null
    const active = customThemes.find((c) => c.id === activeCustomThemeId)
    if (!active) return null
    if (active.sourcePluginId) {
      const candidate = vscodePresets.find(
        (p) =>
          p.source === "plugin" && p.pluginId === active.sourcePluginId && p.name === active.name
      )
      return candidate?.key ?? null
    }
    const importedRecord = importedRecords.find((r) => r.customThemeId === activeCustomThemeId)
    if (importedRecord) return `imported:${activeCustomThemeId}`
    const builtIn = vscodePresets.find(
      (p) => p.source === "builtin" && p.name === (active.sourceBuiltinName ?? active.name)
    )
    return builtIn?.key ?? null
  }, [activeCustomThemeId, customThemes, importedRecords, vscodePresets])

  // ── Search + variant filter ────────────────────────────────────────────
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query.trim().toLowerCase())
  const [variantFilter, setVariantFilter] = useState<VariantFilter>("all")
  const filteredPresets = useMemo(() => {
    return vscodePresets.filter((p) => {
      if (variantFilter !== "all" && (variantFilter === "dark") !== p.isDark) return false
      if (deferred && !p.name.toLowerCase().includes(deferred)) return false
      return true
    })
  }, [vscodePresets, variantFilter, deferred])

  // ── Import dialog ──────────────────────────────────────────────────────
  const [importOpen, setImportOpen] = useState(false)

  // ── Disable plugin confirmation ────────────────────────────────────────
  const [pendingDisable, setPendingDisable] = useState<{
    pluginId: string
    pluginName: string
  } | null>(null)

  // ── Activation ─────────────────────────────────────────────────────────
  const handleSelect = (item: PresetItem) => {
    if (item.source === "imported" && item.customThemeId) {
      // Imported themes already have a persistent row; activate it directly.
      if (item.customThemeId === activeCustomThemeId) {
        void setActiveCustom(null)
      } else {
        void setActiveCustom(item.customThemeId)
      }
      return
    }
    // Built-in or plugin: clone into a persistent CustomTheme. The clone
    // survives plugin disable / app restart per user-decision (c). Reuse
    // an existing clone (matched by source identity) when one already
    // exists — otherwise repeated clicks would spawn N duplicate rows.
    if (item.key === activeKey) {
      void setActiveCustom(null)
      return
    }
    const existingClone = customThemes.find((ct) => {
      if (item.source === "plugin" && item.pluginId) {
        return ct.sourcePluginId === item.pluginId && ct.name === item.name
      }
      if (item.source === "builtin") {
        return ct.sourceBuiltinName === item.name
      }
      return false
    })
    if (existingClone) {
      void setActiveCustom(existingClone.id)
      return
    }
    const baseVariant: "light" | "dark" = item.isDark ? "dark" : "light"
    const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
    const tokens = {
      [baseVariant]: item.colors,
      [opposite]: deriveOppositeVariant(item.colors, baseVariant),
    } as { light: ThemeColors; dark: ThemeColors }
    const seed: Omit<CustomTheme, "id"> = {
      name: item.name,
      baseVariant,
      derivedVariant: opposite,
      tokens,
      isDark: baseVariant === "dark",
      colors: item.colors,
      sourcePluginId: item.source === "plugin" ? item.pluginId : undefined,
      sourceBuiltinName: item.source === "builtin" ? item.name : undefined,
    }
    const id = createCustomTheme(seed)
    void setActiveCustom(id)
  }

  const handleEditCopy = (item: PresetItem) => {
    const baseVariant: "light" | "dark" = item.isDark ? "dark" : "light"
    const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
    const tokens = {
      [baseVariant]: item.colors,
      [opposite]: deriveOppositeVariant(item.colors, baseVariant),
    } as { light: ThemeColors; dark: ThemeColors }
    const id = createCustomTheme({
      name: `${item.name} (copy)`,
      baseVariant,
      derivedVariant: opposite,
      tokens,
      isDark: baseVariant === "dark",
      colors: item.colors,
      sourcePluginId: item.source === "plugin" ? item.pluginId : undefined,
    })
    void setActiveCustom(id)
    const next = new URLSearchParams(searchParams.toString())
    next.set("appearanceTab", "custom")
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  const handleRemoveImported = async (item: PresetItem) => {
    if (!item.customThemeId) return
    const { deleteCustomTheme, removeImportedTheme } = useSettingsStore.getState()
    deleteCustomTheme(item.customThemeId)
    await removeImportedTheme(item.customThemeId)
  }

  const handleDisablePluginRequest = (item: PresetItem) => {
    if (!item.pluginId) return
    setPendingDisable({ pluginId: item.pluginId, pluginName: item.pluginName ?? item.pluginId })
  }

  const confirmDisablePlugin = async () => {
    if (!pendingDisable) return
    try {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().disablePlugin(
        pendingDisable.pluginId,
        "user-disable-from-theme-card"
      )
    } catch (err) {
      console.warn("disable plugin from theme card failed", err)
    } finally {
      setPendingDisable(null)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("themeLabel")}</h3>
        <RadioGroup
          value={theme}
          onValueChange={(v) => {
            const next = v as AppTheme
            setTheme(next)
            void save({ theme: next })
          }}
          className="flex flex-wrap gap-4"
        >
          {(["light", "dark", "system"] as AppTheme[]).map((opt) => (
            <label key={opt} className="flex cursor-pointer items-center gap-2 text-sm">
              <RadioGroupItem value={opt} id={`theme-${opt}`} />
              {t(`theme.${opt}`)}
            </label>
          ))}
        </RadioGroup>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("colorPresetLabel")}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {COLOR_PRESETS.map((preset) => {
            const swatches = PRESET_SWATCHES[preset]
            const active = colorTheme === preset && !activeCustomThemeId
            return (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  if (activeCustomThemeId) void setActiveCustom(null)
                  void save({ colorTheme: preset })
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md border-2 px-2 py-2 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary" : "border-border hover:border-foreground/30"
                )}
                aria-pressed={active}
              >
                <span className="flex flex-col gap-0.5">
                  <span className="size-3 rounded-full" style={{ background: swatches.light }} />
                  <span className="size-3 rounded-full" style={{ background: swatches.dark }} />
                </span>
                <span className="truncate">{t(`colorPresets.${preset}`)}</span>
              </button>
            )
          })}
        </div>
        {activeCustomThemeId && (
          <p className="text-[11px] text-muted-foreground">
            {t("customTheme.activateButton")} → {t("customTheme.deactivateButton")}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{t("vscode.legend")}</h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1 text-xs"
            onClick={() => setImportOpen(true)}
          >
            <UploadIcon className="size-3" />
            {t("vscode.importShort")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("vscode.search.placeholder")}
            className="h-8 text-xs sm:max-w-xs"
            aria-label={t("vscode.search.placeholder")}
          />
          <ToggleGroup
            type="single"
            size="sm"
            value={variantFilter}
            onValueChange={(value) => {
              if (value) setVariantFilter(value as VariantFilter)
            }}
            className="text-xs"
          >
            <ToggleGroupItem value="all">{t("vscode.filter.all")}</ToggleGroupItem>
            <ToggleGroupItem value="light">{t("vscode.filter.light")}</ToggleGroupItem>
            <ToggleGroupItem value="dark">{t("vscode.filter.dark")}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <PresetGrid
          items={filteredPresets}
          activeKey={activeKey}
          onSelect={handleSelect}
          onEditCopy={handleEditCopy}
          onRemoveImported={handleRemoveImported}
          onDisablePlugin={handleDisablePluginRequest}
        />
      </section>

      <VscodeImportDialog open={importOpen} onOpenChange={setImportOpen} />

      <AlertDialog
        open={pendingDisable !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisable(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("vscode.disablePlugin.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("vscode.disablePlugin.body", { name: pendingDisable?.pluginName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("vscode.disablePlugin.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDisablePlugin()}>
              {t("vscode.disablePlugin.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
