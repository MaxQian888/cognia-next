"use client"

// Settings tab — probe enable + cadences + warning threshold. Settings live
// in `AppSettings.subscriptionSettings`; the store's `save({...})` method
// persists to Dexie and re-broadcasts.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SettingsAlert, SettingsCard } from "@/components/settings/common/settings-section"
import { CustomSourcesCard } from "@/components/settings/subscription/custom-sources-card"

import {
  DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS as DEFAULT_SUBSCRIPTION_SETTINGS,
  type AnthropicSubscriptionSettings as SubscriptionSettings,
} from "@/types/subscription"
import { PROBE_CADENCE_FLOOR_MS, clampCadence } from "@/lib/subscription/anthropic/scheduler"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"

function loadSettings(
  app: { subscriptionSettings?: SubscriptionSettings } | null
): SubscriptionSettings {
  return app?.subscriptionSettings ?? DEFAULT_SUBSCRIPTION_SETTINGS
}

export function SubscriptionSettingsTab() {
  const t = useTranslations("subscription")
  const tabReady = isTauri()
  const settings = useSettingsStore((s) => loadSettings(s.settings))
  const save = useSettingsStore((s) => s.save)

  const [draft, setDraft] = useState<SubscriptionSettings>(settings)
  // Re-sync the draft when the persisted settings change (another tab saved
  // while this one was open). Derived-state-from-prop pattern preferred over
  // useEffect — see React docs.
  const [lastSettings, setLastSettings] = useState(settings)
  if (settings !== lastSettings) {
    setLastSettings(settings)
    setDraft(settings)
  }

  const dirty =
    draft.probeEnabled !== settings.probeEnabled ||
    draft.visibleIntervalMs !== settings.visibleIntervalMs ||
    draft.idleIntervalMs !== settings.idleIntervalMs ||
    draft.warnThresholdPct !== settings.warnThresholdPct

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  const onSave = async () => {
    await save({
      subscriptionSettings: {
        probeEnabled: draft.probeEnabled,
        visibleIntervalMs: clampCadence(draft.visibleIntervalMs),
        idleIntervalMs: clampCadence(draft.idleIntervalMs),
        warnThresholdPct: Math.max(0, Math.min(100, Math.round(draft.warnThresholdPct))),
      },
    })
  }

  const onReset = () => setDraft(DEFAULT_SUBSCRIPTION_SETTINGS)

  return (
    <div className="space-y-3">
      <SettingsCard title={t("settings.probe.title")} description={t("settings.probe.description")}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="probe-enabled">{t("settings.probe.enableLabel")}</Label>
              <p className="text-xs text-muted-foreground">{t("settings.probe.enableHelp")}</p>
            </div>
            <Switch
              id="probe-enabled"
              checked={draft.probeEnabled}
              onCheckedChange={(v) => setDraft({ ...draft, probeEnabled: v })}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="visible-cadence">{t("settings.probe.visibleLabel")}</Label>
            <Input
              id="visible-cadence"
              type="number"
              min={Math.floor(PROBE_CADENCE_FLOOR_MS / 1000)}
              value={Math.round(draft.visibleIntervalMs / 1000)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  visibleIntervalMs: Math.max(0, Number(e.target.value)) * 1000,
                })
              }
              disabled={!draft.probeEnabled}
            />
            <p className="text-xs text-muted-foreground">{t("settings.probe.visibleHelp")}</p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="idle-cadence">{t("settings.probe.idleLabel")}</Label>
            <Input
              id="idle-cadence"
              type="number"
              min={Math.floor(PROBE_CADENCE_FLOOR_MS / 1000)}
              value={Math.round(draft.idleIntervalMs / 1000)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  idleIntervalMs: Math.max(0, Number(e.target.value)) * 1000,
                })
              }
              disabled={!draft.probeEnabled}
            />
            <p className="text-xs text-muted-foreground">{t("settings.probe.idleHelp")}</p>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.threshold.title")}
        description={t("settings.threshold.description")}
      >
        <div className="space-y-1">
          <Label htmlFor="warn-threshold">{t("settings.threshold.label")}</Label>
          <Input
            id="warn-threshold"
            type="number"
            min={0}
            max={100}
            value={draft.warnThresholdPct}
            onChange={(e) => setDraft({ ...draft, warnThresholdPct: Number(e.target.value) })}
          />
          <p className="text-xs text-muted-foreground">{t("settings.threshold.help")}</p>
        </div>
      </SettingsCard>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onReset} disabled={!dirty}>
          {t("settings.actions.reset")}
        </Button>
        <Button onClick={onSave} disabled={!dirty}>
          {t("settings.actions.save")}
        </Button>
      </div>

      <CustomSourcesCard />
    </div>
  )
}
