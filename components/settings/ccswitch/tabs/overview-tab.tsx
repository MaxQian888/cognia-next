"use client"

// CCSwitch → Overview tab. Status banner (DB detected? path? counts?), a
// banner showing which provider cognia-next + each tracked agent currently
// runs, and a drift banner when those disagree.

import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import {
  ArrowLeftRightIcon,
  CheckCircle2Icon,
  FolderOpenIcon,
  AlertTriangleIcon,
} from "lucide-react"

import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { invoke } from "@tauri-apps/api/core"

import { useCcswitchProviders, useCcswitchStatus } from "@/lib/ccswitch/hooks"
import { detectActive } from "@/lib/ccswitch/switch"
import type { ActiveProviderState, CcswitchProvider } from "@/lib/ccswitch/types"
import type { ClaudeSettings } from "@/lib/claude/settings"
import { getSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"

/**
 * Read `~/.claude/settings.json`'s env block via the existing
 * `read_claude_user_settings` IPC. The env block lives under `extra.env`
 * (it's not modeled explicitly in `ClaudeSettings`).
 */
async function readClaudeCodeProviderEnv(): Promise<{
  apiKey?: string
  baseUrl?: string
} | null> {
  const settings = await invoke<ClaudeSettings | null>("read_claude_user_settings")
  if (!settings) return null
  const env = (settings.extra?.env ?? {}) as Record<string, unknown>
  const apiKey = typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY : undefined
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : undefined
  if (!apiKey && !baseUrl) return null
  return { apiKey, baseUrl }
}

export function CcswitchOverviewTab() {
  const t = useTranslations("ccswitch")
  const tabReady = isTauri()

  const [watchDb, setWatchDb] = useState(false)
  useEffect(() => {
    if (!tabReady) return
    void getSettings().then((s) => {
      setWatchDb(s.ccswitchSync?.watchDb ?? true)
    })
  }, [tabReady])

  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useCcswitchStatus(tabReady, watchDb)
  const { data: providers } = useCcswitchProviders(tabReady && status?.exists === true, watchDb)

  const [active, setActive] = useState<ActiveProviderState | null>(null)
  const [activeLoading, setActiveLoading] = useState(false)

  useEffect(() => {
    if (!tabReady || !providers) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async detect on data refresh; cancellation guards stale writes
    setActiveLoading(true)
    detectActive(providers, {
      agentReaders: {
        "claude-code": readClaudeCodeProviderEnv,
      },
    })
      .then((s) => {
        if (!cancelled) setActive(s)
      })
      .finally(() => {
        if (!cancelled) setActiveLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [providers, tabReady])

  if (!tabReady) {
    return (
      <SettingsAlert title={t("overview.webModeTitle")}>{t("overview.webModeBody")}</SettingsAlert>
    )
  }

  if (statusLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (statusError) {
    return (
      <SettingsAlert variant="destructive" title={t("overview.errorTitle")}>
        {statusError}
      </SettingsAlert>
    )
  }

  if (!status?.exists) {
    return (
      <SettingsCard
        icon={<ArrowLeftRightIcon className="size-4" />}
        title={t("overview.notFoundTitle")}
        description={t("overview.notFoundBody")}
      >
        <div className="text-xs text-muted-foreground font-mono break-all">
          {status?.dbPath ?? "—"}
        </div>
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={refreshStatus}>
            {t("overview.recheck")}
          </Button>
        </div>
      </SettingsCard>
    )
  }

  const activeProvider = active?.cognia ? providers?.find((p) => p.id === active.cognia) : undefined

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<CheckCircle2Icon className="size-4 text-green-600" />}
        title={t("overview.detectedTitle")}
        description={t("overview.detectedBody")}
        headerAction={
          <Button variant="ghost" size="sm" onClick={refreshStatus}>
            {t("overview.recheck")}
          </Button>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">{t("overview.dbPath")}</div>
            <div className="font-mono text-xs break-all flex items-center gap-1">
              <FolderOpenIcon className="size-3 shrink-0" />
              {status.dbPath ?? "—"}
            </div>
            {status.resolutionSource && status.resolutionSource !== "default" && (
              <Badge variant="outline" className="mt-1 text-[10px]">
                {t(`overview.resolutionSource.${status.resolutionSource}`)}
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <CountBadge label={t("counts.providers")} value={status.counts.providers} />
            <CountBadge label={t("counts.mcpServers")} value={status.counts.mcpServers} />
            <CountBadge label={t("counts.prompts")} value={status.counts.prompts} />
            <CountBadge label={t("counts.skills")} value={status.counts.skills} />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t("overview.activeTitle")} description={t("overview.activeBody")}>
        {activeLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : activeProvider ? (
          <ActiveProviderRow provider={activeProvider} />
        ) : (
          <SettingsEmptyState
            title={t("overview.noActive")}
            description={t("overview.noActiveBody")}
          />
        )}
      </SettingsCard>

      {active?.drift && (
        <SettingsAlert
          variant="destructive"
          icon={<AlertTriangleIcon className="size-4" />}
          title={t("overview.driftTitle")}
        >
          {t("overview.driftBody")}
        </SettingsAlert>
      )}
    </div>
  )
}

function CountBadge({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border bg-muted/30 px-2 py-1 text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-base font-medium tabular-nums">{value}</div>
    </div>
  )
}

function ActiveProviderRow({ provider }: { provider: CcswitchProvider }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm">{provider.name}</div>
        <div className="text-xs text-muted-foreground font-mono break-all">
          {provider.baseUrl ?? "https://api.anthropic.com"}
        </div>
      </div>
      {provider.kind && (
        <Badge variant="secondary" className="text-[10px]">
          {provider.kind}
        </Badge>
      )}
    </div>
  )
}
