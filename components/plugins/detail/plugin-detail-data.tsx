"use client"

// Data sub-tab — bundles the lifetime/operational surfaces that don't
// belong in Overview / Capabilities / Configure / Permissions:
//
//   - PluginDataManagement   Dexie tables this plugin owns
//   - PluginScheduledJobs    cron jobs filtered to this plugin
//   - PluginAnalytics        invocation counts / errors filtered to this plugin
//   - PluginBackupPanel      per-plugin backup/restore controls
//   - PluginResourceManager  rate-limit token bucket inspector
//   - PluginDependencyGraph  dependency tree visualization
//
// Every child reads pluginId off props and pulls its own data, so this
// pane stays a thin composition wrapper.

import { useTranslations } from "next-intl"

import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import { DEFAULT_RATE_LIMITS } from "@/lib/plugin/security/rate-limiter"
import { PluginAnalytics } from "../plugin-analytics"
import { PluginScheduledJobs } from "../plugin-scheduled-jobs"
import { PluginBackupPanel } from "../plugin-backup-panel"
import { PluginResourceManager } from "../plugin-resource-manager"
import { PluginDependencyGraph } from "../plugin-dependency-graph"
import { PluginDataManagement } from "@/components/settings/plugins/plugin-data-management"

// Match the rate-limit reshape the old PluginDetail used so we stay
// API-compatible with PluginResourceManager.
const RESOURCE_LIMITS = Object.entries(DEFAULT_RATE_LIMITS).map(([key, cfg]) => ({
  key,
  limit: cfg.capacity,
  windowMs: cfg.refillPerSecond > 0 ? Math.round(1000 / cfg.refillPerSecond) : 0,
}))

export function PluginDetailData({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)

  if (rowState.state === "loading") {
    return (
      <div className="space-y-3" data-testid="plugin-detail-data-loading" aria-busy="true">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }
  if (rowState.state === "not-found") {
    return <p className="text-sm text-muted-foreground">{t("notFound")}</p>
  }
  const plugin = rowState.row
  const manifest = plugin.manifest as { dependencies?: Record<string, string> }

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("sectionTables")}</h3>
        <PluginDataManagement pluginId={pluginId} />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("sectionSchedules")}</h3>
        <PluginScheduledJobs pluginId={pluginId} />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("sectionAnalytics")}</h3>
        <PluginAnalytics pluginId={pluginId} />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("sectionBackup")}</h3>
        <PluginBackupPanel pluginId={pluginId} />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("sectionResources")}</h3>
        <PluginResourceManager pluginId={pluginId} limits={RESOURCE_LIMITS} />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("sectionDependencies")}</h3>
        <PluginDependencyGraph manifest={{ id: plugin.id, dependencies: manifest.dependencies }} />
      </section>
    </div>
  )
}
