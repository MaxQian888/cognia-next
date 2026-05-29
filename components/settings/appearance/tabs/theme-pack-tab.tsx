"use client"

// Theme-pack picker. Lists `manifest.themePacks` contributions registered by
// enabled plugins (ADR-0029/0030) and applies a one-click bundle (theme +
// fonts + wallpaper + density + radius + motion) via `applyThemePack`. Before
// this tab the theme-pack registry had no UI consumer at all — packs were
// registered on enable but unreachable.

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { useSettingsStore } from "@/stores/settings"
import {
  listThemePacks,
  subscribeThemePackRegistry,
  type RegisteredThemePack,
} from "@/lib/theme/theme-pack-registry"
import {
  listPluginThemes,
  subscribeThemeRegistry,
  type PluginTheme,
} from "@/lib/theme/theme-registry"
import { applyThemePack } from "@/lib/theme/theme-pack-applier"

// Stable empty fallbacks for the SSR / pre-hydration snapshot.
const EMPTY_PACKS: RegisteredThemePack[] = []
const EMPTY_THEMES: PluginTheme[] = []

export function ThemePackTab() {
  const t = useTranslations("settings.appearance.themePack")
  const packs = useSyncExternalStore(subscribeThemePackRegistry, listThemePacks, () => EMPTY_PACKS)
  const pluginThemes = useSyncExternalStore(
    subscribeThemeRegistry,
    listPluginThemes,
    () => EMPTY_THEMES
  )
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const setActiveWallpaper = useSettingsStore((s) => s.setActiveWallpaper)
  const setActiveCustomTheme = useSettingsStore((s) => s.setActiveCustomTheme)
  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)

  const onApply = (pack: RegisteredThemePack) => {
    applyThemePack(pack, {
      settings: {
        typographyExt: settings?.typographyExt,
        radius: settings?.radius,
        motion: settings?.motion,
        density: settings?.density,
        customThemes: settings?.customThemes,
      },
      pluginThemes,
      save,
      setActiveWallpaper,
      setActiveCustomTheme,
      createCustomTheme,
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {packs.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">{t("empty")}</p>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
        >
          {packs.map((pack) => (
            <Card key={`${pack.pluginId}.${pack.id}`} className="flex flex-col gap-2 p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{pack.name}</p>
                {pack.pluginName && (
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {pack.pluginName}
                  </p>
                )}
                {pack.description && (
                  <p className="text-xs text-muted-foreground">{pack.description}</p>
                )}
              </div>
              <Button
                size="sm"
                className="mt-auto self-start"
                onClick={() => onApply(pack)}
                aria-label={`${t("apply")}: ${pack.name}`}
              >
                {t("apply")}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
