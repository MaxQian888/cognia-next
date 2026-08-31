"use client"

// Claude provider panel: usage and routing presets. Account CRUD and credential
// detail live exclusively in the unified Account Center.

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { isTauri } from "@/lib/tauri"
import { PresetPicker } from "../preset-picker"
import { ProviderQuotaPanel } from "../provider-quota-panel"

export function ClaudeAccountPanel() {
  const t = useTranslations("subscription.nav.items.claude")
  const tRoot = useTranslations("subscription")

  // Quota and preset operations are desktop-backed, so fail early in web mode.
  if (!isTauri()) {
    return <SettingsAlert title={t("label")}>{tRoot("webModeBanner")}</SettingsAlert>
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("label")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <ProviderQuotaPanel provider="anthropic" />
      <PresetPicker provider="anthropic" />
    </div>
  )
}
