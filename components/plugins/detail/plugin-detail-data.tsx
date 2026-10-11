"use client"

// Data tab — bundles the lifetime/operational surfaces that don't belong in
// Overview / Capabilities / Configure / Permissions:
//
//   - PluginDataManagement   Dexie tables this plugin owns (+ "Delete data")
//   - PluginScheduledJobs    cron jobs filtered to this plugin
//   - PluginAnalytics        invocation counts / errors filtered to this plugin
//   - PluginBackupPanel      per-plugin backup/restore controls
//   - PluginResourceManager  rate-limit token buckets
//   - PluginDependencyGraph  dependency verdict, list, and (on request) graph
//
// The tab owns the full pane height, so it draws no box of its own: each
// surface is a flat `PluginDetailGroup` (icon + heading, hairline above),
// always visible. Only the dependency canvas waits behind a disclosure inside
// its section, because it is the one costly render; its verdict is not hidden.
//
// The same children also render in a phone drawer, so each carries its own
// anonymous `@container` and lays out by its own width.
//
// Every child reads pluginId off props and pulls its own data, so this pane
// stays a thin composition wrapper.

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  BarChart3Icon,
  ClockIcon,
  DatabaseIcon,
  GaugeIcon,
  GitBranchIcon,
} from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import { DEFAULT_RATE_LIMITS } from "@/lib/plugin/security/rate-limiter"
import { PluginAnalytics } from "./plugin-analytics"
import { PluginScheduledJobs } from "./plugin-scheduled-jobs"
import { PluginBackupPanel } from "../plugin-backup-panel"
import { PluginResourceManager, type RateLimitMeta } from "./plugin-resource-manager"
import { PluginDependencyGraph } from "./plugin-dependency-graph"
import { PluginDetailGroup } from "./plugin-detail-group"
import { PluginDataManagement } from "@/components/settings/plugins/plugin-data-management"

const MINUTE_MS = 60_000

/**
 * The limiter's token buckets in reader terms: the sustained rate per minute
 * (`refillPerSecond × 60`) and the burst (`capacity`). This used to report
 * `capacity` per `1000 / refillPerSecond` ms, i.e. the full burst over the time
 * it takes to refill ONE token, which overstated every rate below one per
 * second. A bucket that never refills is a total (`windowMs: 0`).
 */
export const RESOURCE_LIMITS: RateLimitMeta[] = Object.entries(DEFAULT_RATE_LIMITS).map(
  ([key, cfg]) =>
    cfg.refillPerSecond > 0
      ? {
          key,
          limit: Math.round(cfg.refillPerSecond * 60),
          windowMs: MINUTE_MS,
          burst: cfg.capacity,
        }
      : { key, limit: cfg.capacity, windowMs: 0 }
)

const ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground"

export function PluginDetailData({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const td = useTranslations("plugins.detailData")
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
  const declaredDependencies = Object.keys(manifest.dependencies ?? {}).length

  return (
    <div className="@container space-y-4" data-testid="plugin-detail-data">
      <DataSection
        title={t("sectionTables")}
        icon={<DatabaseIcon className={ICON_CLASS} aria-hidden="true" />}
        testId="data-sub-tables"
      >
        <PluginDataManagement pluginId={pluginId} />
      </DataSection>

      <DataSection
        title={t("sectionSchedules")}
        icon={<ClockIcon className={ICON_CLASS} aria-hidden="true" />}
        testId="data-sub-schedules"
      >
        <PluginScheduledJobs pluginId={pluginId} />
      </DataSection>

      <DataSection
        title={t("sectionAnalytics")}
        icon={<BarChart3Icon className={ICON_CLASS} aria-hidden="true" />}
        testId="data-sub-analytics"
      >
        <PluginAnalytics pluginId={pluginId} />
      </DataSection>

      <DataSection
        title={t("sectionBackup")}
        icon={<ArchiveIcon className={ICON_CLASS} aria-hidden="true" />}
        testId="data-sub-backup"
      >
        <PluginBackupPanel pluginId={pluginId} />
      </DataSection>

      <DataSection
        title={t("sectionResources")}
        icon={<GaugeIcon className={ICON_CLASS} aria-hidden="true" />}
        testId="data-sub-resources"
      >
        <PluginResourceManager pluginId={pluginId} limits={RESOURCE_LIMITS} />
      </DataSection>

      <DataSection
        title={t("sectionDependencies")}
        icon={<GitBranchIcon className={ICON_CLASS} aria-hidden="true" />}
        summary={td("dependencyCount", { count: declaredDependencies })}
        testId="data-sub-dependencies"
      >
        <PluginDependencyGraph manifest={{ id: plugin.id, dependencies: manifest.dependencies }} />
      </DataSection>
    </div>
  )
}

/** One flat section: the shared group primitive with a muted summary slot. */
function DataSection({
  title,
  icon,
  summary,
  testId,
  children,
}: {
  title: string
  icon: ReactNode
  summary?: string
  testId: string
  children: ReactNode
}) {
  return (
    <PluginDetailGroup
      title={title}
      icon={icon}
      testId={testId}
      className="pt-4 first:pt-0"
      actions={
        summary ? (
          <span className="text-xs text-muted-foreground" data-testid={`${testId}-summary`}>
            {summary}
          </span>
        ) : undefined
      }
    >
      {children}
    </PluginDetailGroup>
  )
}
