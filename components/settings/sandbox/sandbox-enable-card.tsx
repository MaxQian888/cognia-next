// ADR-0028 Phase 5 — app-level "enable sandbox by default" toggle.
//
// `AppSettings.sandboxDefaultEnabled` is read by
// `lib/claude/build-options.ts:resolveSendOptions` as the final fallback in
// the sandbox precedence chain (session → character → app default). It had no
// UI, so the whole sandbox layer could only be turned on per-character — this
// card exposes the global switch. Persists through the same store + saveSettings
// path the tier card uses.

"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"

export function SandboxEnableCard() {
  const t = useTranslations("settings.sandbox.enable")
  const settings = useSettingsStore((s) => s.settings)
  const switchId = useId()
  const enabled = settings?.sandboxDefaultEnabled ?? false

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={switchId} className="text-sm font-medium">
            {t("label")}
          </Label>
          <Switch
            id={switchId}
            checked={enabled}
            onCheckedChange={(checked) => void saveSettings({ sandboxDefaultEnabled: checked })}
            data-testid="sandbox-default-enabled-switch"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </CardContent>
    </Card>
  )
}
