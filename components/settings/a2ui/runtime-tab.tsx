"use client"

// A2UI Runtime tab — global defaults that apply when a character / session
// does not override them. All settings persist into the AppSettings
// singleton row and round-trip through backup v3.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { DEFAULT_CATALOG_ID, getRegisteredCatalogIds } from "@/lib/a2ui/catalog"
import {
  MAX_A2UI_PERSISTENCE_LIMIT,
  MIN_A2UI_PERSISTENCE_LIMIT,
  getA2UIPersistenceLimit,
  resolveA2UICatalogId,
} from "@/lib/a2ui/runtime-settings"
import { useSettingsStore } from "@/stores/settings"
import { useA2UIStore } from "@/stores/a2ui"
import type { AppSettings } from "@cognia/agent-config-types"
import type { A2UIWidgetHostStrategy, A2UIWidgetTheme } from "@/types/a2ui/schema"

const HOST_STRATEGIES: A2UIWidgetHostStrategy[] = [
  "native",
  "artifact-preview",
  "sandboxed-html",
  "lazy-runtime",
]
const THEMES: A2UIWidgetTheme[] = ["inherit", "light", "dark"]

export function RuntimeTab() {
  const t = useTranslations("settings.a2ui.runtime")
  const settings = useSettingsStore((state) => state.settings)
  const loaded = useSettingsStore((state) => state.loaded)
  const load = useSettingsStore((state) => state.load)
  const save = useSettingsStore((state) => state.save)
  const flushA2UIPersistence = useA2UIStore((state) => state.flushPersistence)
  const [saving, setSaving] = useState(false)
  const [persistenceLimitDraft, setPersistenceLimitDraft] = useState<number | null>(null)
  const catalogIds = useMemo(() => getRegisteredCatalogIds(), [])

  useEffect(() => {
    if (!loaded) {
      void load()
    }
  }, [load, loaded])

  const patch = useCallback(
    async (value: Partial<AppSettings>): Promise<boolean> => {
      setSaving(true)
      try {
        await save(value)
        if (value.a2uiPersistenceLimit !== undefined) {
          flushA2UIPersistence()
        }
        return true
      } catch (error) {
        toast.error(
          t("saveFailed", { error: error instanceof Error ? error.message : String(error) })
        )
        return false
      } finally {
        setSaving(false)
      }
    },
    [flushA2UIPersistence, save, t]
  )

  if (!loaded || !settings) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("loading")}
        </CardContent>
      </Card>
    )
  }

  const selectedCatalogId = resolveA2UICatalogId(undefined, settings.a2uiDefaultCatalogId)
  const persistenceLimit = persistenceLimitDraft ?? getA2UIPersistenceLimit(settings)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("global.title")}</CardTitle>
          <CardDescription>{t("global.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="a2ui-default-enabled">{t("global.enabledLabel")}</Label>
              <p className="text-xs text-muted-foreground">{t("global.enabledHelp")}</p>
            </div>
            <Switch
              id="a2ui-default-enabled"
              checked={!!settings.a2uiDefaultEnabled}
              disabled={saving}
              onCheckedChange={(v) => void patch({ a2uiDefaultEnabled: v })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="a2ui-default-catalog">{t("global.catalogLabel")}</Label>
            <Select
              value={selectedCatalogId}
              disabled={saving}
              onValueChange={(v) => void patch({ a2uiDefaultCatalogId: v || undefined })}
            >
              <SelectTrigger id="a2ui-default-catalog">
                <SelectValue placeholder={t("global.catalogPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {catalogIds.map((catalogId) => (
                  <SelectItem key={catalogId} value={catalogId}>
                    {catalogId === DEFAULT_CATALOG_ID ? t("global.standardCatalog") : catalogId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("global.catalogHelp")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("widget.title")}</CardTitle>
          <CardDescription>{t("widget.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="a2ui-default-host-strategy">{t("widget.hostStrategyLabel")}</Label>
            <Select
              value={settings.a2uiDefaultHostStrategy ?? "native"}
              disabled={saving}
              onValueChange={(v) =>
                void patch({ a2uiDefaultHostStrategy: v as A2UIWidgetHostStrategy })
              }
            >
              <SelectTrigger id="a2ui-default-host-strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOST_STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`widget.hostStrategies.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="a2ui-default-theme">{t("widget.themeLabel")}</Label>
            <Select
              value={settings.a2uiDefaultTheme ?? "inherit"}
              disabled={saving}
              onValueChange={(v) => void patch({ a2uiDefaultTheme: v as A2UIWidgetTheme })}
            >
              <SelectTrigger id="a2ui-default-theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((theme) => (
                  <SelectItem key={theme} value={theme}>
                    {t(`widget.themes.${theme}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("persistence.title")}</CardTitle>
          <CardDescription>{t("persistence.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="a2ui-persistence-limit">{t("persistence.limitLabel")}</Label>
              <span className="text-sm font-mono">{persistenceLimit}</span>
            </div>
            <Slider
              id="a2ui-persistence-limit"
              aria-label={t("persistence.limitLabel")}
              min={MIN_A2UI_PERSISTENCE_LIMIT}
              max={MAX_A2UI_PERSISTENCE_LIMIT}
              step={1}
              disabled={saving}
              value={[persistenceLimit]}
              onValueChange={([value]) => setPersistenceLimitDraft(value)}
              onValueCommit={([value]) => {
                void patch({ a2uiPersistenceLimit: value }).then(() => {
                  setPersistenceLimitDraft(null)
                })
              }}
            />
            <p className="text-xs text-muted-foreground">{t("persistence.limitHelp")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
