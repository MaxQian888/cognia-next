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

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { usePluginRow } from "@/hooks/plugins"
import { DEFAULT_RATE_LIMITS } from "@/lib/plugin/security/rate-limiter"
import { PluginAnalytics } from "./plugin-analytics"
import { PluginScheduledJobs } from "./plugin-scheduled-jobs"
import { PluginBackupPanel } from "../plugin-backup-panel"
import { PluginResourceManager } from "./plugin-resource-manager"
import { PluginDependencyGraph } from "./plugin-dependency-graph"
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
    <div className="space-y-2">
      {/* Tables open by default — the most-reached maintenance surface; the
          rest are second-level collapsibles so the dense Data section stays
          scannable in the narrow right pane. */}
      <DataSubSection title={t("sectionTables")} testId="data-sub-tables" defaultOpen>
        <PluginDataManagement pluginId={pluginId} />
      </DataSubSection>

      <DataSubSection title={t("sectionSchedules")} testId="data-sub-schedules">
        <PluginScheduledJobs pluginId={pluginId} />
      </DataSubSection>

      <DataSubSection title={t("sectionAnalytics")} testId="data-sub-analytics">
        <PluginAnalytics pluginId={pluginId} />
      </DataSubSection>

      <DataSubSection title={t("sectionBackup")} testId="data-sub-backup">
        <PluginBackupPanel pluginId={pluginId} />
      </DataSubSection>

      <DataSubSection title={t("sectionResources")} testId="data-sub-resources">
        <PluginResourceManager pluginId={pluginId} limits={RESOURCE_LIMITS} />
      </DataSubSection>

      <DataSubSection title={t("sectionDependencies")} testId="data-sub-dependencies">
        <PluginDependencyGraph manifest={{ id: plugin.id, dependencies: manifest.dependencies }} />
      </DataSubSection>
    </div>
  )
}

function DataSubSection({
  title,
  testId,
  defaultOpen = false,
  children,
}: {
  title: string
  testId?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
        data-testid={testId}
        data-state={open ? "open" : "closed"}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="flex-1 text-left">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="p-3 pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
