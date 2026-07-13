"use client"

// A2UI Runtime tab — global defaults that apply when a character / session
// does not override them. All settings persist into the AppSettings
// singleton row and round-trip through backup v3.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
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
import { getSettings, saveSettings } from "@/lib/db/settings"
import { CATEGORY_KEYS } from "@/lib/a2ui/constants"
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
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    void getSettings().then(setSettings)
  }, [])

  if (!settings) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("loading")}
        </CardContent>
      </Card>
    )
  }

  const patch = async (p: Partial<AppSettings>) => {
    const next = await saveSettings(p)
    setSettings(next)
  }

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
              onCheckedChange={(v) => void patch({ a2uiDefaultEnabled: v })}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("global.catalogLabel")}</Label>
            <Select
              value={settings.a2uiDefaultCatalogId ?? ""}
              onValueChange={(v) => void patch({ a2uiDefaultCatalogId: v || undefined })}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("global.catalogPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key}
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
            <Label>{t("widget.hostStrategyLabel")}</Label>
            <Select
              value={settings.a2uiDefaultHostStrategy ?? "native"}
              onValueChange={(v) =>
                void patch({ a2uiDefaultHostStrategy: v as A2UIWidgetHostStrategy })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOST_STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("widget.themeLabel")}</Label>
            <Select
              value={settings.a2uiDefaultTheme ?? "inherit"}
              onValueChange={(v) => void patch({ a2uiDefaultTheme: v as A2UIWidgetTheme })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
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
              <Label>{t("persistence.limitLabel")}</Label>
              <span className="text-sm font-mono">{settings.a2uiPersistenceLimit ?? 20}</span>
            </div>
            <Slider
              min={5}
              max={100}
              step={1}
              value={[settings.a2uiPersistenceLimit ?? 20]}
              onValueChange={([v]) => void patch({ a2uiPersistenceLimit: v })}
            />
            <p className="text-xs text-muted-foreground">{t("persistence.limitHelp")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
