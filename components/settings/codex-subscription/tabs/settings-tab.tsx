"use client"

// Codex Subscription → Settings tab. Two toggles + a Save button. The
// settings live under `AppSettings.codexSubscriptionSettings` and feed the
// env-builder (preferDiscovered) and the Account tab's refresh button
// (autoRefreshNearExpiry).

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, SaveIcon, UndoIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SettingsAlert, SettingsCard } from "@/components/settings/common/settings-section"

import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type CodexSubscriptionSettings,
} from "@/lib/codex-subscription/types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"

function readCodexSettings(
  appSettings: { codexSubscriptionSettings?: CodexSubscriptionSettings } | null | undefined
): CodexSubscriptionSettings {
  return {
    ...DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
    ...(appSettings?.codexSubscriptionSettings ?? {}),
  }
}

export function CodexSubscriptionSettingsTab() {
  const t = useTranslations("codexSubscription")
  const tabReady = isTauri()
  const [draft, setDraft] = useState<CodexSubscriptionSettings>(DEFAULT_CODEX_SUBSCRIPTION_SETTINGS)
  const [original, setOriginal] = useState<CodexSubscriptionSettings>(
    DEFAULT_CODEX_SUBSCRIPTION_SETTINGS
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void getSettings().then((s) => {
      if (!alive) return
      const next = readCodexSettings(s)
      setOriginal(next)
      setDraft(next)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("usage.loading")}</p>
  }

  const dirty =
    draft.preferDiscovered !== original.preferDiscovered ||
    draft.autoRefreshNearExpiry !== original.autoRefreshNearExpiry

  const onSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveSettings({ codexSubscriptionSettings: draft })
      setOriginal(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const onReset = () => {
    setDraft(DEFAULT_CODEX_SUBSCRIPTION_SETTINGS)
  }

  return (
    <div className="space-y-4">
      <SettingsCard
        title={t("settings.preferDiscovered.title")}
        description={t("settings.preferDiscovered.description")}
      >
        <ToggleRow
          id="codex-prefer-discovered"
          label={t("settings.preferDiscovered.label")}
          help={t("settings.preferDiscovered.help")}
          checked={draft.preferDiscovered}
          onChange={(v) => setDraft((d) => ({ ...d, preferDiscovered: v }))}
        />
      </SettingsCard>

      <SettingsCard
        title={t("settings.autoRefresh.title")}
        description={t("settings.autoRefresh.description")}
      >
        <ToggleRow
          id="codex-auto-refresh"
          label={t("settings.autoRefresh.label")}
          help={t("settings.autoRefresh.help")}
          checked={draft.autoRefreshNearExpiry}
          onChange={(v) => setDraft((d) => ({ ...d, autoRefreshNearExpiry: v }))}
        />
      </SettingsCard>

      {error && (
        <SettingsAlert variant="destructive" title={t("settings.actions.errorTitle")}>
          {error}
        </SettingsAlert>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void onSave()} disabled={!dirty || saving}>
          {saving ? (
            <Loader2Icon className="mr-2 size-4 animate-spin" />
          ) : (
            <SaveIcon className="mr-2 size-4" />
          )}
          {t("settings.actions.save")}
        </Button>
        <Button variant="outline" size="sm" onClick={onReset} disabled={saving}>
          <UndoIcon className="mr-2 size-4" />
          {t("settings.actions.reset")}
        </Button>
      </div>
    </div>
  )
}

function ToggleRow({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string
  label: string
  help: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
