"use client"

// CCSwitch → Sync settings tab. Persists `AppSettings.ccswitchSync`:
//   - enabled         → master on/off (greys the rest of the section)
//   - watchDb         → re-poll on focus to keep the active badge fresh
//   - defaultPropagation → pre-checked agents in the "Use here & in…" dialog

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  SettingsAlert,
  SettingsCard,
  SettingsToggle,
} from "@/components/settings/common/settings-section"

import { getSettings, saveSettings } from "@/lib/db/settings"
import type { AgentId } from "@/lib/claude/types"
import { isTauri } from "@/lib/tauri"

const PROPAGATABLE_AGENTS: AgentId[] = ["claude-code"]

export function CcswitchSyncTab() {
  const t = useTranslations("ccswitch")
  const tabReady = isTauri()
  const [enabled, setEnabled] = useState(true)
  const [watchDb, setWatchDb] = useState(true)
  const [propagation, setPropagation] = useState<AgentId[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!tabReady) return
    void getSettings().then((s) => {
      const cfg = s.ccswitchSync

      setEnabled(cfg?.enabled ?? true)
      setWatchDb(cfg?.watchDb ?? true)
      setPropagation(cfg?.defaultPropagation ?? [])
      setLoaded(true)
    })
  }, [tabReady])

  const togglePropagation = (id: AgentId, checked: boolean) => {
    setPropagation((prev) =>
      checked ? Array.from(new Set([...prev, id])) : prev.filter((a) => a !== id)
    )
  }

  const onSave = async () => {
    setSaving(true)
    try {
      await saveSettings({
        ccswitchSync: {
          enabled,
          watchDb,
          defaultPropagation: propagation,
        },
      })
    } finally {
      setSaving(false)
    }
  }

  if (!tabReady) {
    return (
      <SettingsAlert title={t("overview.webModeTitle")}>{t("overview.webModeBody")}</SettingsAlert>
    )
  }

  if (!loaded) return <Skeleton className="h-32 w-full" />

  return (
    <div className="space-y-3">
      <SettingsCard title={t("sync.flagsTitle")} description={t("sync.flagsBody")}>
        <div className="space-y-2">
          <SettingsToggle
            id="ccswitch-enabled"
            label={t("sync.enabledLabel")}
            description={t("sync.enabledBody")}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <SettingsToggle
            id="ccswitch-watch-db"
            label={t("sync.watchDbLabel")}
            description={t("sync.watchDbBody")}
            checked={watchDb}
            onCheckedChange={setWatchDb}
            disabled={!enabled}
          />
        </div>
      </SettingsCard>

      <SettingsCard title={t("sync.propagationTitle")} description={t("sync.propagationBody")}>
        <div className="space-y-2">
          {PROPAGATABLE_AGENTS.map((a) => (
            <label key={a} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/50">
              <Checkbox
                checked={propagation.includes(a)}
                onCheckedChange={(v) => togglePropagation(a, v === true)}
                disabled={!enabled}
              />
              <span className="text-sm">{t(`agents.${a}`)}</span>
            </label>
          ))}
        </div>
      </SettingsCard>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? t("sync.saving") : t("sync.save")}
        </Button>
      </div>
    </div>
  )
}
