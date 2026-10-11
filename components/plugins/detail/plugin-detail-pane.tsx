"use client"

// The plugin detail surface: a fixed header (identity, status, actions), a
// tab bar, and one scrolling body for the active tab.
//
//   ┌ header: name · status · [Enabled] [Update] [⋯] [×] ┐
//   ├ Overview  Capabilities  Configure  Permissions 6  Data ┤
//   │ active tab, full height, the pane's only scroller     │
//
// Why tabs. This used to be a README-centric column with Capabilities /
// Configure / Permissions / Data as bordered accordions underneath, one open
// at a time. The accordions sat below the metadata, the dependencies and the
// verification group, so "change a setting" meant scrolling past the
// Overview to find a collapsed row, and an open section drew its content
// inside its own border (a box in a box in the pane, four levels deep in
// Data). A tab bar puts every section one click away at a fixed position and
// gives the active one the whole height. Overview stays the landing tab, so
// the README is still what a selection opens on.
//
// The active tab is the store's `detailSubTab`: `?subtab=` deep links and
// `openConfigure()` select a tab exactly as they used to expand a section. It
// is NOT reset when the selection changes, on purpose: stepping through the
// list on the Permissions tab compares what each plugin holds.
//
// Logs is not a tab. The log panel owns log reading; the header's actions
// menu links there (or says why a runtime has no log channel).
//
// The pane is plugin-id-keyed, so switching plugins re-mounts every tab's
// local state (form values in Configure, expanded lists in Data).
//
// Every adaptive rule inside measures the pane (`@container/plugin-detail`),
// never the viewport: the pane is a fraction of the window on a desktop and
// the whole width in a phone drawer.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  BlocksIcon,
  DatabaseIcon,
  InfoIcon,
  SearchXIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePluginRow } from "@/hooks/plugins"
import { getAllContributions } from "@/lib/plugin/contracts/capability-contributions"
import type { PluginRow } from "@/lib/db/plugin-types"
import { cn } from "@/lib/utils"
import { usePluginsStore, type PluginDetailSubTab } from "@/stores/plugins"
import {
  pluginHasConfigureSurface,
  pluginHasReviewablePermissions,
} from "../plugin-row-actions-menu"
import { PluginDetailEmpty } from "./plugin-detail-empty"
import { PluginDetailHeader } from "./plugin-detail-header"
import { PluginDetailOverview } from "./plugin-detail-overview"
import { PluginDetailCapabilities } from "./plugin-detail-capabilities"
import { PluginDetailConfigure } from "./plugin-detail-configure"
import { PluginDetailPermissions } from "./plugin-detail-permissions"
import { PluginDetailData } from "./plugin-detail-data"

export interface PluginDetailPaneProps {
  /**
   * Close the detail. The inline desktop pane passes this so its header shows
   * a close button; the phone drawer and the tablet sheet have their own.
   */
  onClose?: () => void
  /**
   * Called after something in the pane changed the library's filters (a
   * keyword chip). Hosts that COVER the list (drawer, sheet) dismiss here so
   * the user sees the filtered list.
   */
  onFilterApplied?: () => void
  /**
   * The host draws a close button in the top-right corner (the tablet
   * Sheet's own); the header keeps that corner clear so the button does not
   * sit on the plugin's name.
   */
  reserveCloseCorner?: boolean
}

interface TabDef {
  value: PluginDetailSubTab
  labelKey: string
  icon: ComponentType<{ className?: string }>
}

const TABS: ReadonlyArray<TabDef> = [
  { value: "overview", labelKey: "subtab.overview", icon: InfoIcon },
  { value: "capabilities", labelKey: "subtab.capabilities", icon: BlocksIcon },
  { value: "configure", labelKey: "subtab.configure", icon: SettingsIcon },
  { value: "permissions", labelKey: "subtab.permissions", icon: ShieldCheckIcon },
  { value: "data", labelKey: "subtab.data", icon: DatabaseIcon },
]

export function PluginDetailPane({
  onClose,
  onFilterApplied,
  reserveCloseCorner,
}: PluginDetailPaneProps) {
  const detailPluginId = usePluginsStore((s) => s.detailPluginId)

  if (!detailPluginId) {
    return <PluginDetailEmpty />
  }
  return (
    <PluginDetailPaneContent
      key={detailPluginId}
      pluginId={detailPluginId}
      onClose={onClose}
      onFilterApplied={onFilterApplied}
      reserveCloseCorner={reserveCloseCorner}
    />
  )
}

function PluginDetailPaneContent({
  pluginId,
  onClose,
  onFilterApplied,
  reserveCloseCorner,
}: { pluginId: string } & PluginDetailPaneProps) {
  const t = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)
  const subTab = usePluginsStore((s) => s.detailSubTab)
  const setSubTab = usePluginsStore((s) => s.setDetailSubTab)
  const closeDetail = usePluginsStore((s) => s.closeDetail)

  if (rowState.state === "loading") {
    return (
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="plugin-detail-pane-loading"
        aria-busy="true"
      >
        <header className="shrink-0 space-y-2 border-b px-3 py-3">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="h-5 w-2/3" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-7 w-1/2" />
        </header>
        <div className="flex shrink-0 gap-3 border-b px-3 py-2">
          {TABS.map((tab) => (
            <Skeleton key={tab.value} className="h-4 w-12" />
          ))}
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    )
  }

  if (rowState.state === "not-found") {
    // A dead end used to be a bare sentence. Say what probably happened and
    // give the one action that gets out of it.
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
        data-testid="plugin-detail-not-found"
      >
        <SearchXIcon className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{t("notFound")}</p>
        <p className="max-w-xs text-xs text-muted-foreground">{t("notFoundHint")}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-1 pointer-coarse:h-10"
          onClick={onClose ?? closeDetail}
        >
          {t("notFoundAction")}
        </Button>
      </div>
    )
  }

  const plugin = rowState.row

  return (
    <div className="@container/plugin-detail flex h-full min-h-0 flex-col">
      <PluginDetailHeader
        plugin={plugin}
        onClose={onClose}
        reserveCloseCorner={reserveCloseCorner}
      />

      <Tabs
        value={subTab}
        onValueChange={(value) => setSubTab(value as PluginDetailSubTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <DetailTabList plugin={plugin} />

        {TABS.map((tab) => (
          <TabsContent
            key={tab.value}
            value={tab.value}
            // The pane's one vertical scroller. Tabs render nothing that
            // scrolls on its own axis; long lists cap and expand instead.
            className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3 @lg/plugin-detail:px-4"
            data-testid={`plugin-detail-tab-panel-${tab.value}`}
          >
            {renderTab(tab.value, pluginId, onFilterApplied)}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function renderTab(
  tab: PluginDetailSubTab,
  pluginId: string,
  onFilterApplied: (() => void) | undefined
): ReactNode {
  switch (tab) {
    case "overview":
      return <PluginDetailOverview pluginId={pluginId} onFilterApplied={onFilterApplied} />
    case "capabilities":
      return <PluginDetailCapabilities pluginId={pluginId} />
    case "configure":
      return <PluginDetailConfigure pluginId={pluginId} />
    case "permissions":
      return <PluginDetailPermissions pluginId={pluginId} />
    case "data":
      return <PluginDetailData pluginId={pluginId} />
  }
}

/**
 * The tab bar. Underlined ("line") tabs rather than a segmented pill: five
 * labels in a 300px pane need every pixel, and a pill draws a box around the
 * whole row. The row scrolls sideways instead of wrapping when the labels do
 * not fit (long English labels in the narrowest pane).
 *
 * Two counts ride on the labels because they answer "is there anything
 * here?" before the click: how many runtime capabilities the plugin
 * contributes, and how many permissions it declares. Configure reads muted
 * when the plugin has nothing to configure, but stays clickable so the tab
 * can say so.
 */
function DetailTabList({ plugin }: { plugin: PluginRow }) {
  const t = useTranslations("plugins.detail")
  const contributions = useMemo(
    () => getAllContributions(plugin.capabilities, plugin.manifest),
    [plugin.capabilities, plugin.manifest]
  )
  const permissionCount = useMemo(() => {
    const manifest = (plugin.manifest ?? {}) as {
      permissions?: unknown[]
      optionalPermissions?: unknown[]
    }
    return (manifest.permissions?.length ?? 0) + (manifest.optionalPermissions?.length ?? 0)
  }, [plugin.manifest])
  const counts: Partial<Record<PluginDetailSubTab, number>> = {
    capabilities: contributions.length,
    permissions: pluginHasReviewablePermissions(plugin) ? permissionCount : 0,
  }
  const configurable = pluginHasConfigureSurface(plugin)

  return (
    <div className="shrink-0 border-b">
      <TabsList
        variant="line"
        aria-label={t("subtabAria")}
        className="h-auto w-full justify-start gap-0 overflow-x-auto overscroll-x-contain px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TABS.map(({ value, labelKey, icon: Icon }) => {
          const count = counts[value]
          const label = t(labelKey)
          return (
            <TabsTrigger
              key={value}
              value={value}
              className={cn(
                "h-9 flex-none gap-1.5 px-2 text-xs pointer-coarse:h-11",
                value === "configure" && !configurable && "text-muted-foreground/70"
              )}
              aria-label={count ? t("tabCountAria", { label, count }) : undefined}
              data-testid={`plugin-detail-tab-${value}`}
            >
              <Icon className="size-3.5 @md/plugin-detail:inline hidden" aria-hidden />
              <span>{label}</span>
              {count ? (
                <span
                  className="rounded-full bg-muted px-1.5 text-[10px] leading-4 font-normal text-muted-foreground tabular-nums"
                  aria-hidden
                >
                  {count}
                </span>
              ) : null}
            </TabsTrigger>
          )
        })}
      </TabsList>
    </div>
  )
}
