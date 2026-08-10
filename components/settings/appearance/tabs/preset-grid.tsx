"use client"

// Single grid that renders VSCode presets from all three sources (built-in,
// imported, plugin) with consistent affordances:
//   - 3-swatch icon (background / primary / accent) synthesised from
//     `colors`, so plugin themes get an icon for free.
//   - Source badge in the corner ("Built-in" / "Imported" / "From plugin: …").
//   - Per-card overflow menu: Set active / Edit copy / Delete or Disable.
//
// The grid is presentational. Activation, edit-copy seeding, and plugin
// disable are forwarded as callbacks so the tab can drive the
// settings-store / plugin-manager side effects.

import { useTranslations } from "next-intl"
import { MoreHorizontalIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { synthesizeThemeSwatches } from "@/lib/appearance/synthesize-theme-icon"
import type { ThemeColors } from "@/types/plugin/plugin"
import { cn } from "@/lib/utils"

export type PresetSource = "builtin" | "imported" | "plugin"

export interface PresetItem {
  /** Stable dedupe / key string. */
  key: string
  /** User-facing card title. */
  name: string
  /** Palette used for the swatch and (later) for activation. */
  colors: ThemeColors
  /**
   * Both authored variants, when the source ships them (built-in VSCode +
   * designed themes). Preferred over deriving on clone so a theme's
   * hand-authored opposite variant is preserved instead of being replaced by
   * an algorithmic inversion.
   */
  tokens?: { light: ThemeColors; dark: ThemeColors }
  /** Drives the variant pill + light/dark filter. */
  isDark: boolean
  /** Origin badge. */
  source: PresetSource
  /** For `plugin` source: stable plugin id (used by Disable plugin action). */
  pluginId?: string
  /** For `plugin` source: human-readable plugin name (badge text). */
  pluginName?: string
  /**
   * For `plugin` source: the theme's registry id (`<pluginId>.<contributionId>`).
   * Drives direct activation (`activePluginThemeId`) without cloning.
   */
  pluginThemeId?: string
  /**
   * For `plugin` source: raw extra CSS vars from a `cssVariables` theme,
   * carried into a clone so a "copy" keeps every declared override.
   */
  cssVars?: Record<string, string>
  /** For `imported` source: persistent CustomTheme id (used by Remove action). */
  customThemeId?: string
}

export interface PresetGridProps {
  items: PresetItem[]
  /** Item.key of the currently active preset (or null). */
  activeKey: string | null
  /** Single-click activates the preset. */
  onSelect: (item: PresetItem) => void
  /** Optional context menu actions — pass to enable each one. */
  onEditCopy?: (item: PresetItem) => void
  onRemoveImported?: (item: PresetItem) => void
  onDisablePlugin?: (item: PresetItem) => void
}

export function PresetGrid({
  items,
  activeKey,
  onSelect,
  onEditCopy,
  onRemoveImported,
  onDisablePlugin,
}: PresetGridProps) {
  const t = useTranslations("settings.appearance.vscode")
  const ts = useTranslations("settings.appearance.vscode.source")

  if (items.length === 0) {
    return (
      <p className="rounded border border-dashed p-3 text-center text-xs text-muted-foreground">
        {t("noResults")}
      </p>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => {
        const swatches = synthesizeThemeSwatches(item.colors)
        const active = item.key === activeKey
        const variant: "light" | "dark" = item.isDark ? "dark" : "light"
        const sourceLabel =
          item.source === "builtin"
            ? ts("builtin")
            : item.source === "imported"
              ? ts("imported")
              : ts("fromPlugin", { name: item.pluginName ?? "" })
        return (
          <div
            key={item.key}
            className={cn(
              "group relative flex flex-col gap-1 rounded border p-2 text-left transition",
              "hover:bg-accent/50 focus-within:border-ring",
              active && "border-primary bg-primary/5"
            )}
          >
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full flex-col items-start gap-1 whitespace-normal p-0 text-left font-normal hover:bg-transparent"
              onClick={() => onSelect(item)}
              aria-pressed={active}
            >
              <div className="flex gap-1">
                <span
                  className="h-4 w-4 rounded"
                  style={{ background: swatches.background }}
                  aria-hidden
                />
                <span
                  className="h-4 w-4 rounded"
                  style={{ background: swatches.primary }}
                  aria-hidden
                />
                <span
                  className="h-4 w-4 rounded"
                  style={{ background: swatches.accent }}
                  aria-hidden
                />
              </div>
              <div className="mt-1 truncate text-xs font-medium">
                {item.name}
                {active && (
                  <span className="ml-1 text-[10px] text-primary">{t("activeLabel")}</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">{t(`variant.${variant}`)}</span>
                <Badge variant="outline" className="px-1 py-0 text-[9px] leading-none">
                  {sourceLabel}
                </Badge>
              </div>
            </Button>

            <div className="absolute right-1 top-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label={t("menu.aria", { name: item.name })}
                  >
                    <MoreHorizontalIcon className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onSelect(item)}>
                    {t("menu.setActive")}
                  </DropdownMenuItem>
                  {onEditCopy && (
                    <DropdownMenuItem onClick={() => onEditCopy(item)}>
                      {t("menu.editCopy")}
                    </DropdownMenuItem>
                  )}
                  {(onRemoveImported && item.source === "imported") ||
                  (onDisablePlugin && item.source === "plugin") ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {onRemoveImported && item.source === "imported" && (
                    <DropdownMenuItem
                      onClick={() => onRemoveImported(item)}
                      className="text-destructive focus:text-destructive"
                    >
                      {t("menu.delete")}
                    </DropdownMenuItem>
                  )}
                  {onDisablePlugin && item.source === "plugin" && (
                    <DropdownMenuItem
                      onClick={() => onDisablePlugin(item)}
                      className="text-destructive focus:text-destructive"
                    >
                      {t("menu.disablePlugin")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )
      })}
    </div>
  )
}
