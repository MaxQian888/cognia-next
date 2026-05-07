"use client"

// A2UI bridge tab — single switch controlling whether new sessions get the
// `mcp__a2ui-bridge__*` toolset by default. Per-character / per-mode
// overrides live in the Custom Mode editor; this tab governs the global
// default that flows into `resolveSendOptions`.

import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"

export function A2UIBridgeTab() {
  const t = useTranslations("settings.agentRuntimeSection.a2ui")
  const enabled = useSettingsStore((s) => s.settings?.a2uiDefaultEnabled ?? false)
  const save = useSettingsStore((s) => s.save)

  const handleToggle = (value: boolean) => {
    void save({ a2uiDefaultEnabled: value })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-sm">{t("title")}</CardTitle>
          <CardDescription className="text-xs">{t("description")}</CardDescription>
        </div>
        <Switch checked={Boolean(enabled)} onCheckedChange={handleToggle} aria-label={t("title")} />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </CardContent>
    </Card>
  )
}

export default A2UIBridgeTab
