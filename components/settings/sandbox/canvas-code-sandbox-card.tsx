// ADR-0028 — Canvas code-execution sandbox toggle.
//
// `AppSettings.canvasCodeSandboxEnabled` is read by
// `hooks/canvas/use-code-execution.ts` to decide whether Canvas-executed code
// (Python especially) runs through the OS sandbox or as a bare host
// subprocess. It defaults to TRUE (confined out of the box) and is independent
// of `sandboxDefaultEnabled` (which gates chat Bash/Edit/Write). This card is
// the deliberate opt-out for trusted machines / platforms without a backend.

"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"

export function CanvasCodeSandboxCard() {
  const t = useTranslations("settings.sandbox.canvasSandbox")
  const settings = useSettingsStore((s) => s.settings)
  const switchId = useId()
  // Default ON — confined unless the user explicitly opts out.
  const enabled = settings?.canvasCodeSandboxEnabled ?? true

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
            onCheckedChange={(checked) => void saveSettings({ canvasCodeSandboxEnabled: checked })}
            data-testid="canvas-code-sandbox-switch"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </CardContent>
    </Card>
  )
}
