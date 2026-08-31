"use client"

// Codex provider tab — quota, routing presets, and connection/probe settings.
// Account CRUD lives exclusively in the unified Account Center.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  SettingsAlert,
  SettingsCard,
  SettingsToggle,
} from "@/components/settings/common/settings-section"

import { PROBE_CADENCE_FLOOR_MS } from "@/lib/subscription/anthropic/scheduler"
import { useAccounts } from "@/lib/subscription/core/hooks"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { PresetPicker } from "./preset-picker"
import { ProviderQuotaPanel } from "./provider-quota-panel"

import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type AccountSummary,
  type CodexSubscriptionSettings,
} from "@/types/subscription"

function getCodexSettings(
  appSettings: { codexSubscriptionSettings?: CodexSubscriptionSettings } | null | undefined
): CodexSubscriptionSettings {
  return appSettings?.codexSubscriptionSettings ?? DEFAULT_CODEX_SUBSCRIPTION_SETTINGS
}

/**
 * Is the active Codex account an api-key login? `AccountSummary.expiresAtMs` is
 * documented as `0 when not applicable (api_key / opencode-zen)`, and a ChatGPT
 * login always carries a real expiry — so for a `codex`-variant account a zero
 * expiry means api-key mode.
 *
 * It matters because rate-limit windows are a ChatGPT-*subscription* concept:
 * upstream answers "chatgpt authentication required to read rate limits" for an
 * api key, so there is no quota to fetch and the panel is legitimately empty.
 * Say that, rather than leaving a blank gap that reads as a bug.
 */
function usesApiKeyOnly(accounts: AccountSummary[], activeAccountId: string | null): boolean {
  const active = accounts.find((a) => a.id === activeAccountId)
  return !!active && active.variant === "codex" && active.expiresAtMs === 0
}

export function ProviderTabCodex() {
  const t = useTranslations("subscription.codex")
  const tSettings = useTranslations("subscription.codex.settings")
  const codexSettings = useSettingsStore((s) => getCodexSettings(s.settings))
  const save = useSettingsStore((s) => s.save)
  const [draftOverride, setDraftOverride] = useState<CodexSubscriptionSettings | null>(null)
  const draft = draftOverride ?? codexSettings
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [saveError, setSaveError] = useState<string | null>(null)
  const { accounts, activeAccountId } = useAccounts("codex")
  const apiKeyOnly = usesApiKeyOnly(accounts, activeAccountId)
  const draftDirty = !codexSettingsEqual(draft, codexSettings)
  const draftError = validateDraft(draft)

  const applyDraft = async () => {
    if (draftError) return
    setSaveState("saving")
    setSaveError(null)
    try {
      await save({
        codexSubscriptionSettings: {
          ...draft,
          warnThresholdPct: Math.round(draft.warnThresholdPct),
        },
      })
      setSaveState("saved")
      setDraftOverride(null)
    } catch (cause) {
      setSaveState("error")
      setSaveError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const updateDraft = (patch: Partial<CodexSubscriptionSettings>) => {
    setDraftOverride((current) => ({ ...(current ?? codexSettings), ...patch }))
    setSaveState("idle")
    setSaveError(null)
  }
  const cadenceFloorSec = Math.floor(PROBE_CADENCE_FLOOR_MS / 1000)

  // Every action on this tab ends in a keychain-backed Tauri command. Say so up
  // front rather than letting the user walk an add-account flow that can only
  // reject at the final IPC call. Matches the Overview/Account tabs.
  if (!isTauri()) {
    return <SettingsAlert title={t("title")}>{t("webModeBanner")}</SettingsAlert>
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {/* Rate-limit windows require a ChatGPT login — an API key has no usage
          endpoint upstream. This sits *above* the panel: showing an empty gauge
          first and only then explaining it reads as a broken fetch. */}
      {apiKeyOnly && (
        <p className="text-xs text-muted-foreground" data-testid="codex-quota-api-key-only">
          {t("quotaApiKeyOnly")}
        </p>
      )}

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
          checked={draft.autoRefreshNearExpiry}
          onCheckedChange={(value) => updateDraft({ autoRefreshNearExpiry: value })}
        />
        <DraftActions
          dirty={draftDirty}
          error={draftError}
          saveError={saveError}
          saveState={saveState}
          onApply={applyDraft}
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
          checked={draft.probeEnabled}
          onCheckedChange={(value) => updateDraft({ probeEnabled: value })}
        />
        <div className="space-y-1">
          <Label htmlFor="codex-visible-cadence">{tSettings("probe.visibleLabel")}</Label>
          <Input
            id="codex-visible-cadence"
            type="number"
            min={cadenceFloorSec}
            value={Math.round(draft.visibleIntervalMs / 1000)}
            onChange={(event) =>
              updateDraft({ visibleIntervalMs: Number(event.target.value) * 1000 })
            }
            disabled={!draft.probeEnabled}
          />
          <p className="text-xs text-muted-foreground">{tSettings("probe.visibleHelp")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="codex-idle-cadence">{tSettings("probe.idleLabel")}</Label>
          <Input
            id="codex-idle-cadence"
            type="number"
            min={cadenceFloorSec}
            value={Math.round(draft.idleIntervalMs / 1000)}
            onChange={(event) => updateDraft({ idleIntervalMs: Number(event.target.value) * 1000 })}
            disabled={!draft.probeEnabled}
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
            value={draft.warnThresholdPct}
            onChange={(event) => updateDraft({ warnThresholdPct: Number(event.target.value) })}
            disabled={!draft.probeEnabled}
          />
          <p className="text-xs text-muted-foreground">{tSettings("probe.warnHelp")}</p>
        </div>
        <DraftActions
          dirty={draftDirty}
          error={draftError}
          saveError={saveError}
          saveState={saveState}
          onApply={applyDraft}
        />
      </SettingsCard>
    </div>
  )
}

function DraftActions({
  dirty,
  error,
  saveError,
  saveState,
  onApply,
}: {
  dirty: boolean
  error: "invalidCadence" | "invalidThreshold" | null
  saveError: string | null
  saveState: "idle" | "saving" | "saved" | "error"
  onApply: () => Promise<void>
}) {
  const t = useTranslations("subscription.codex.settings")
  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-destructive">{t(error)}</p>}
      {saveError && (
        <p className="text-xs text-destructive">{t("saveFailed", { error: saveError })}</p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && saveState === "idle" && (
          <span className="text-xs text-muted-foreground">{t("pending")}</span>
        )}
        {saveState === "saved" && (
          <span className="text-xs text-muted-foreground">{t("saved")}</span>
        )}
        <Button
          size="sm"
          onClick={() => void onApply()}
          disabled={!dirty || !!error || saveState === "saving"}
        >
          {saveState === "saving" ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  )
}

function validateDraft(
  settings: CodexSubscriptionSettings
): "invalidCadence" | "invalidThreshold" | null {
  if (
    !Number.isFinite(settings.visibleIntervalMs) ||
    !Number.isFinite(settings.idleIntervalMs) ||
    settings.visibleIntervalMs < PROBE_CADENCE_FLOOR_MS ||
    settings.idleIntervalMs < PROBE_CADENCE_FLOOR_MS
  ) {
    return "invalidCadence"
  }
  if (
    !Number.isFinite(settings.warnThresholdPct) ||
    settings.warnThresholdPct < 0 ||
    settings.warnThresholdPct > 100
  ) {
    return "invalidThreshold"
  }
  return null
}

function codexSettingsEqual(
  left: CodexSubscriptionSettings,
  right: CodexSubscriptionSettings
): boolean {
  return (
    left.autoRefreshNearExpiry === right.autoRefreshNearExpiry &&
    left.probeEnabled === right.probeEnabled &&
    left.visibleIntervalMs === right.visibleIntervalMs &&
    left.idleIntervalMs === right.idleIntervalMs &&
    left.warnThresholdPct === right.warnThresholdPct
  )
}
