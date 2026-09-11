"use client"

import { useTranslations } from "next-intl"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { Label } from "@/components/ui/label"
import { isTauri } from "@/lib/tauri"
import { PresetPicker } from "./preset-picker"

/** Provider configuration; account creation is owned by AccountCenter. */
export function ProviderTabCommandcode() {
  const t = useTranslations("subscription.commandcode")
  const tProvider = useTranslations("subscription.providers")
  if (!isTauri()) {
    return <SettingsAlert title={tProvider("commandcode")}>{t("webModeBanner")}</SettingsAlert>
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{tProvider("commandcode")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-muted-foreground">{t("goUnsupported")}</p>
        <p className="text-xs text-muted-foreground">{t("quotaUnavailable")}</p>
        <a
          href="https://commandcode.ai/docs/provider"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary underline"
        >
          {t("docs")}
        </a>
      </div>
      <PresetPicker provider="commandcode" />
    </div>
  )
}
