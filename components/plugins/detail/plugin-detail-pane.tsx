"use client"

// Right-pane host for the plugin detail surface. Reads `detailPluginId` from
// the plugins store; renders the empty state when nothing is selected,
// otherwise a README-centric pane: the Overview (meta + README) is the
// always-visible reading-first body, and Capabilities / Configure /
// Permissions / Data are collapsible sections below. Logs is the one entry
// that navigates instead of expanding, because the log panel owns log
// reading and this pane's copy of it was a weaker duplicate. Exactly one
// section is open at a time, driven by `detailSubTab`, so a `?subtab=` deep
// link auto-expands the matching section. Every feature the old flat tab
// strip surfaced is preserved — only the chrome changed.
//
// The pane is plugin-id-keyed, so switching between plugins re-mounts the
// section state and the form values inside ConfigForm. This mirrors the old
// PluginDetail's `key={pluginId}` semantics.

import { useTranslations } from "next-intl"
import {
  BlocksIcon,
  DatabaseIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import { usePluginsStore, type PluginDetailSubTab } from "@/stores/plugins"
import { PluginDetailEmpty } from "./plugin-detail-empty"
import { PluginDetailHeader } from "./plugin-detail-header"
import { PluginDetailSection, PluginDetailSectionLink } from "./plugin-detail-section"
import { PluginDetailOverview } from "./plugin-detail-overview"
import { PluginDetailCapabilities } from "./plugin-detail-capabilities"
import { PluginDetailConfigure } from "./plugin-detail-configure"
import { PluginDetailPermissions } from "./plugin-detail-permissions"
import { PluginDetailData } from "./plugin-detail-data"
import { buildPluginLogsHref } from "@/lib/plugin/devtools/plugin-logs-link"
import { isPluginType, logSourcesFor } from "@/lib/plugin/devtools/runtime-log-stream"

interface SectionDef {
  value: Exclude<PluginDetailSubTab, "overview">
  labelKey: string
  icon: ComponentType<{ className?: string }>
  render: (pluginId: string) => ReactNode
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  {
    value: "capabilities",
    labelKey: "subtab.capabilities",
    icon: BlocksIcon,
    render: (id) => <PluginDetailCapabilities pluginId={id} />,
  },
  {
    value: "configure",
    labelKey: "subtab.configure",
    icon: SettingsIcon,
    render: (id) => <PluginDetailConfigure pluginId={id} />,
  },
  {
    value: "permissions",
    labelKey: "subtab.permissions",
    icon: ShieldCheckIcon,
    render: (id) => <PluginDetailPermissions pluginId={id} />,
  },
  {
    value: "data",
    labelKey: "subtab.data",
    icon: DatabaseIcon,
    render: (id) => <PluginDetailData pluginId={id} />,
  },
]

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
  const setSubTab = usePluginsStore((s) => s.setDetailSubTab)

  if (rowState.state === "loading") {
    return (
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="plugin-detail-pane-loading"
        aria-busy="true"
      >
        <header className="shrink-0 space-y-2 border-b px-2.5 py-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-2.5">
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
  // Logs is a link, not a section. Runtimes whose host serves no log channel
  // (wasm, vscode-extension) still get no entry at all rather than a link into
  // a panel that can only ever be empty for them.
  const hasLogChannel = isPluginType(plugin.type) && logSourcesFor(plugin.type).runtimes.length > 0

  return (
    // Container, not viewport: this pane is a fraction of the window, so every
    // adaptive rule inside it has to measure the pane. A `sm:` viewport rule
    // would show the wide layout inside a 280px rail on a large screen.
    <div className="@container/plugin-detail flex h-full min-h-0 flex-col">
      <PluginDetailHeader plugin={plugin} />

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-2.5 @sm/plugin-detail:px-3">
        {/* README-centric body: meta + README are always visible. */}
        <PluginDetailOverview pluginId={pluginId} />

        {SECTIONS.map((section) => (
          <PluginDetailSection
            key={section.value}
            icon={section.icon}
            title={t(section.labelKey)}
            open={subTab === section.value}
            // Open sets this section, collapse falls back to overview (the
            // always-visible body), so at most one section is expanded.
            onOpenChange={(open) => setSubTab(open ? section.value : "overview")}
            testId={`plugin-detail-section-${section.value}`}
          >
            {section.render(pluginId)}
          </PluginDetailSection>
        ))}

        {hasLogChannel ? (
          <PluginDetailSectionLink
            icon={ScrollTextIcon}
            title={t("subtab.logs")}
            description={t("logs.openInPanel")}
            href={buildPluginLogsHref({ pluginId })}
            testId="plugin-detail-section-logs"
          />
        ) : null}
      </div>
    </div>
  )
}
