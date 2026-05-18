"use client"

// Codex provider tab — flat (no inner tabs). Account list + preset picker +
// add-account dialog. Codex doesn't surface usage metrics; users with
// preferences can flip the auto-refresh / preferDiscovered toggles via the
// settings card below.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

import { useSettingsStore } from "@/stores/settings/settings-store"

import { AccountList } from "./account-list"
import { CodexAddAccountDialog } from "./add-account-dialog/codex"
import { PresetPicker } from "./preset-picker"

import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type CodexSubscriptionSettings,
} from "@/lib/subscription/core/types"

function getCodexSettings(
  appSettings: { codexSubscriptionSettings?: CodexSubscriptionSettings } | null | undefined
): CodexSubscriptionSettings {
  return appSettings?.codexSubscriptionSettings ?? DEFAULT_CODEX_SUBSCRIPTION_SETTINGS
}

export function ProviderTabCodex() {
  const t = useTranslations("subscription.codex")
  const tSettings = useTranslations("subscription.codex.settings")
  const [addOpen, setAddOpen] = useState(false)

  const codexSettings = useSettingsStore((s) => getCodexSettings(s.settings))
  const save = useSettingsStore((s) => s.save)

  const togglePreferDiscovered = async (next: boolean) => {
    await save({
      codexSubscriptionSettings: { ...codexSettings, preferDiscovered: next },
    })
  }
  const toggleAutoRefresh = async (next: boolean) => {
    await save({
      codexSubscriptionSettings: { ...codexSettings, autoRefreshNearExpiry: next },
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <AccountList provider="codex" onAdd={() => setAddOpen(true)} />
      <PresetPicker provider="codex" />

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Label className="text-sm">{tSettings("preferDiscovered.title")}</Label>
              <p className="text-xs text-muted-foreground">
                {tSettings("preferDiscovered.description")}
              </p>
            </div>
            <Switch
              checked={codexSettings.preferDiscovered}
              onCheckedChange={(v) => void togglePreferDiscovered(v)}
              aria-label={tSettings("preferDiscovered.label")}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Label className="text-sm">{tSettings("autoRefresh.title")}</Label>
              <p className="text-xs text-muted-foreground">
                {tSettings("autoRefresh.description")}
              </p>
            </div>
            <Switch
              checked={codexSettings.autoRefreshNearExpiry}
              onCheckedChange={(v) => void toggleAutoRefresh(v)}
              aria-label={tSettings("autoRefresh.label")}
            />
          </div>
        </CardContent>
      </Card>

      <CodexAddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
