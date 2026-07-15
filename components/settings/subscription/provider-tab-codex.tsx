"use client"

// Codex provider tab — flat (no inner tabs). Account list + quota panel
// (5h/weekly windows + credit balance for the active account) + preset picker
// + connection-settings card + add-account dialog. The quota panel reuses the
// unified limits surface, so a real ChatGPT subscription shows the same
// gauges as the TUI `/limits` bars.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SettingsCard, SettingsToggle } from "@/components/settings/common/settings-section"

import { PROBE_CADENCE_FLOOR_MS, clampCadence } from "@/lib/subscription/anthropic/scheduler"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { AccountList } from "./account-list"
import { CodexAddAccountDialog } from "./add-account-dialog/codex"
import { PresetPicker } from "./preset-picker"
import { ProviderQuotaPanel } from "./provider-quota-panel"

import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type CodexSubscriptionSettings,
} from "@/types/subscription"

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

  const toggleAutoRefresh = async (next: boolean) => {
    await save({
      codexSubscriptionSettings: { ...codexSettings, autoRefreshNearExpiry: next },
    })
  }
  const toggleProbe = async (next: boolean) => {
    await save({ codexSubscriptionSettings: { ...codexSettings, probeEnabled: next } })
  }
  const saveVisibleCadence = async (seconds: number) => {
    await save({
      codexSubscriptionSettings: {
        ...codexSettings,
        visibleIntervalMs: clampCadence(Math.max(0, seconds) * 1000),
      },
    })
  }
  const saveIdleCadence = async (seconds: number) => {
    await save({
      codexSubscriptionSettings: {
        ...codexSettings,
        idleIntervalMs: clampCadence(Math.max(0, seconds) * 1000),
      },
    })
  }
  const saveWarnThreshold = async (pct: number) => {
    await save({
      codexSubscriptionSettings: {
        ...codexSettings,
        warnThresholdPct: Math.max(0, Math.min(100, Math.round(pct))),
      },
    })
  }
  const cadenceFloorSec = Math.floor(PROBE_CADENCE_FLOOR_MS / 1000)

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <AccountList provider="codex" onAdd={() => setAddOpen(true)} />
      <ProviderQuotaPanel provider="codex" />
      <PresetPicker provider="codex" />

      <SettingsCard
        title={tSettings("cardTitle")}
        description={tSettings("cardDescription")}
        collapsible
        defaultOpen={false}
      >
        <SettingsToggle
          id="codex-auto-refresh"
          label={tSettings("autoRefresh.title")}
          description={tSettings("autoRefresh.description")}
          checked={codexSettings.autoRefreshNearExpiry}
          onCheckedChange={(v) => void toggleAutoRefresh(v)}
        />
      </SettingsCard>

      <SettingsCard
        title={tSettings("probe.cardTitle")}
        description={tSettings("probe.cardDescription")}
        collapsible
        defaultOpen={false}
      >
        <SettingsToggle
          id="codex-probe-enabled"
          label={tSettings("probe.enableTitle")}
          description={tSettings("probe.enableDescription")}
          checked={codexSettings.probeEnabled}
          onCheckedChange={(v) => void toggleProbe(v)}
        />
        <div className="space-y-1">
          <Label htmlFor="codex-visible-cadence">{tSettings("probe.visibleLabel")}</Label>
          <Input
            id="codex-visible-cadence"
            type="number"
            min={cadenceFloorSec}
            value={Math.round(codexSettings.visibleIntervalMs / 1000)}
            onChange={(e) => void saveVisibleCadence(Number(e.target.value))}
            disabled={!codexSettings.probeEnabled}
          />
          <p className="text-xs text-muted-foreground">{tSettings("probe.visibleHelp")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="codex-idle-cadence">{tSettings("probe.idleLabel")}</Label>
          <Input
            id="codex-idle-cadence"
            type="number"
            min={cadenceFloorSec}
            value={Math.round(codexSettings.idleIntervalMs / 1000)}
            onChange={(e) => void saveIdleCadence(Number(e.target.value))}
            disabled={!codexSettings.probeEnabled}
          />
          <p className="text-xs text-muted-foreground">{tSettings("probe.idleHelp")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="codex-warn-threshold">{tSettings("probe.warnLabel")}</Label>
          <Input
            id="codex-warn-threshold"
            type="number"
            min={0}
            max={100}
            value={codexSettings.warnThresholdPct}
            onChange={(e) => void saveWarnThreshold(Number(e.target.value))}
            disabled={!codexSettings.probeEnabled}
          />
          <p className="text-xs text-muted-foreground">{tSettings("probe.warnHelp")}</p>
        </div>
      </SettingsCard>

      <CodexAddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
