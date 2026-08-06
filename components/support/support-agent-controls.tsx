"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  isSupportDiagnosticsEnabled,
  setSupportDiagnosticsEnabled,
} from "@/lib/support-agent/context"

export function SupportAgentControls() {
  const t = useTranslations("settings.characters.support")
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(() =>
    isSupportDiagnosticsEnabled()
  )

  const updateDiagnostics = (enabled: boolean) => {
    setSupportDiagnosticsEnabled(enabled)
    setDiagnosticsEnabled(enabled)
  }

  return (
    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border bg-muted/20 p-2">
      <div className="space-y-0.5">
        <Label htmlFor="support-agent-diagnostics" className="text-[11px] font-medium">
          {t("diagnostics")}
        </Label>
        <p className="text-[10px] text-muted-foreground">{t("diagnosticsDescription")}</p>
      </div>
      <Switch
        id="support-agent-diagnostics"
        checked={diagnosticsEnabled}
        onCheckedChange={updateDiagnostics}
        aria-label={t("diagnostics")}
      />
    </div>
  )
}
