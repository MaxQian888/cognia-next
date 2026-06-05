"use client"

// Right-pane host for the plugin detail surface. Reads `detailPluginId` from
// the plugins store; renders the empty state when nothing is selected,
// otherwise the 5-tab pane (Overview / Capabilities / Configure /
// Permissions / Data). This replaces the older 3-outer-tab + 8-inner-tab
// structure from `plugin-detail.tsx` while preserving every feature it
// surfaced (just relocated across the 5 flat sub-tabs).
//
// The pane is plugin-id-keyed, so switching between plugins re-mounts the
// inner tab state and the form values inside ConfigForm. This mirrors the
// old PluginDetail's `key={pluginId}` semantics.

import { useTranslations } from "next-intl"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { PluginDetailEmpty } from "./plugin-detail-empty"
import { PluginDetailHeader } from "./plugin-detail-header"
import { PluginDetailTabs } from "./plugin-detail-tabs"
import { PluginDetailOverview } from "./plugin-detail-overview"
import { PluginDetailCapabilities } from "./plugin-detail-capabilities"
import { PluginDetailConfigure } from "./plugin-detail-configure"
import { PluginDetailPermissions } from "./plugin-detail-permissions"
import { PluginDetailData } from "./plugin-detail-data"
import { PluginDetailLogs } from "./plugin-detail-logs"

export function PluginDetailPane() {
  const detailPluginId = usePluginsStore((s) => s.detailPluginId)

  if (!detailPluginId) {
    return <PluginDetailEmpty />
  }
  return <PluginDetailPaneContent key={detailPluginId} pluginId={detailPluginId} />
}

function PluginDetailPaneContent({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)
  const subTab = usePluginsStore((s) => s.detailSubTab)

  if (rowState.state === "loading") {
    return (
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="plugin-detail-pane-loading"
        aria-busy="true"
      >
        <header className="shrink-0 border-b px-4 py-3 space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    )
  }

  if (rowState.state === "not-found") {
    return <p className="text-sm text-muted-foreground p-4">{t("notFound")}</p>
  }

  const plugin = rowState.row

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PluginDetailHeader plugin={plugin} />

      <PluginDetailTabs pluginType={plugin.type} />

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {subTab === "overview" && <PluginDetailOverview pluginId={pluginId} />}
        {subTab === "capabilities" && <PluginDetailCapabilities pluginId={pluginId} />}
        {subTab === "configure" && <PluginDetailConfigure pluginId={pluginId} />}
        {subTab === "permissions" && <PluginDetailPermissions pluginId={pluginId} />}
        {subTab === "data" && <PluginDetailData pluginId={pluginId} />}
        {subTab === "logs" && <PluginDetailLogs pluginId={pluginId} />}
      </div>
    </div>
  )
}
