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
import {
  SettingsAlert,
  SettingsCard,
  SettingsToggle,
} from "@/components/settings/common/settings-section"

import { PROBE_CADENCE_FLOOR_MS, clampCadence } from "@/lib/subscription/anthropic/scheduler"
import { useAccounts } from "@/lib/subscription/core/hooks"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { AccountList } from "./account-list"
import { CodexAddAccountDialog } from "./add-account-dialog/codex"
import { PresetPicker } from "./preset-picker"
import { ProviderQuotaPanel } from "./provider-quota-panel"

import {
  type Account,
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
  const [addOpen, setAddOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)

  const codexSettings = useSettingsStore((s) => getCodexSettings(s.settings))
  const save = useSettingsStore((s) => s.save)
  const { accounts, activeAccountId } = useAccounts("codex")
  const apiKeyOnly = usesApiKeyOnly(accounts, activeAccountId)

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

      <AccountList
        provider="codex"
        onAdd={() => {
          setEditingAccount(null)
          setAddOpen(true)
        }}
        onUpdate={(account) => {
          setEditingAccount(account)
          setAddOpen(true)
        }}
      />

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

      <CodexAddAccountDialog
        open={addOpen}
        existingAccount={editingAccount ?? undefined}
        onAdded={() => setEditingAccount(null)}
        onOpenChange={(next) => {
          setAddOpen(next)
          if (!next) setEditingAccount(null)
        }}
      />
    </div>
  )
}
