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
import { useLiveQuery } from "dexie-react-hooks"
import { getPlugin } from "@/lib/db/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { PluginDetailEmpty } from "./plugin-detail-empty"
import { PluginDetailTabs } from "./plugin-detail-tabs"
import { PluginDetailOverview } from "./plugin-detail-overview"
import { PluginDetailCapabilities } from "./plugin-detail-capabilities"
import { PluginDetailConfigure } from "./plugin-detail-configure"
import { PluginDetailPermissions } from "./plugin-detail-permissions"
import { PluginDetailData } from "./plugin-detail-data"

export function PluginDetailPane() {
  const detailPluginId = usePluginsStore((s) => s.detailPluginId)

  if (!detailPluginId) {
    return <PluginDetailEmpty />
  }
  return <PluginDetailPaneContent key={detailPluginId} pluginId={detailPluginId} />
}

function PluginDetailPaneContent({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])
  const subTab = usePluginsStore((s) => s.detailSubTab)

  if (!plugin) {
    return <p className="text-sm text-muted-foreground p-4">{t("notFound")}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 py-3 space-y-1">
        <h2 className="text-base font-semibold">
          {plugin.name}{" "}
          <span className="text-muted-foreground text-sm font-normal">v{plugin.version}</span>
        </h2>
        {(plugin.manifest as { description?: string }).description ? (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {(plugin.manifest as { description?: string }).description}
          </p>
        ) : null}
      </header>

      <PluginDetailTabs />

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {subTab === "overview" && <PluginDetailOverview pluginId={pluginId} />}
        {subTab === "capabilities" && <PluginDetailCapabilities pluginId={pluginId} />}
        {subTab === "configure" && <PluginDetailConfigure pluginId={pluginId} />}
        {subTab === "permissions" && <PluginDetailPermissions pluginId={pluginId} />}
        {subTab === "data" && <PluginDetailData pluginId={pluginId} />}
      </div>
    </div>
  )
}
