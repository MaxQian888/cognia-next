"use client"

// Desktop → cognia CLI storage sync (CLI ↔ APP unification). Surfaces:
//   - whether a CLI home (`~/.cognia` / $COGNIA_HOME) is reachable,
//   - a manual "Sync now" that pushes config + credentials + history + MCP,
//   - an auto-sync toggle that pushes config + credentials on boot / on enable.
// MCP server projection is also available per-server via the agent-sync chips
// in the MCP settings page (the cognia CLI is one of the sync targets there).

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon, RefreshCwIcon, TerminalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { resolveCliHome } from "@/lib/cli-bridge/home"
import { maybeAutoPushToCli } from "@/lib/cli-bridge/auto-push"
import {
  countPushErrors,
  countPushSuccesses,
  pushToCli,
  type PushReport,
} from "@/lib/cli-bridge/push-to-cli"

export function CliSyncCard() {
  const t = useTranslations("settings.cliBridge")
  const settings = useSettingsStore((s) => s.settings)
  const setAutoSync = useSettingsStore((s) => s.setCliBridgeAutoSync)
  const [home, setHome] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    void (async () => {
      const resolved = await resolveCliHome()
      if (!alive) return
      setHome(resolved)
      setChecking(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!isTauri()) return null

  const autoSync = Boolean(settings?.cliBridge?.autoSync)

  const summarize = (report: PushReport) => {
    if (!report.home) {
      toast.message(t("toast.noHome"))
      return
    }
    const ok = countPushSuccesses(report)
    const errors = countPushErrors(report)
    if (errors > 0) toast.error(t("toast.partial", { ok, errors }))
    else toast.success(t("toast.done", { ok }))
  }

  const onSyncNow = async () => {
    if (!settings) return
    setSyncing(true)
    try {
      const report = await pushToCli(settings)
      summarize(report)
      setHome(report.home)
    } catch (err) {
      toast.error(t("toast.failed", { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSyncing(false)
    }
  }

  const onToggleAutoSync = async (next: boolean) => {
    await setAutoSync(next)
    if (next && settings) {
      const report = await maybeAutoPushToCli({
        ...settings,
        cliBridge: { ...settings.cliBridge, autoSync: true },
      })
      if (report) summarize(report)
    }
  }

  const statusDescription = checking
    ? t("status.checking")
    : home
      ? t("status.detected", { home })
      : t("status.notDetected")

  return (
    <SettingsCard
      icon={<TerminalIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <SettingsRow label={t("status.label")} description={statusDescription}>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => void onSyncNow()}
          disabled={syncing || checking || !home}
        >
          {syncing ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="mr-1.5 size-3.5" />
          )}
          {t("syncNow")}
        </Button>
      </SettingsRow>

      <SettingsToggle
        id="cli-bridge-auto-sync"
        label={t("autoSync.label")}
        description={t("autoSync.hint")}
        checked={autoSync}
        onCheckedChange={(next) => void onToggleAutoSync(next)}
      />

      <p className="text-[11px] text-muted-foreground">{t("codexChatGptHint")}</p>
      <p className="text-[11px] text-muted-foreground">{t("mcpHint")}</p>
    </SettingsCard>
  )
}
