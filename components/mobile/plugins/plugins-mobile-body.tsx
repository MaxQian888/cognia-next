"use client"

/**
 * `/plugins` on a phone.
 *
 * `FeaturePageShell` has a mobile branch, but for this page it produced a dead
 * end: the right pane became an UNCONTROLLED Sheet, so tapping a plugin row
 * (which only writes `detailPluginId` to the store) did nothing visible, and
 * the detail was reachable only by finding a 16px panel icon in a 36px control
 * strip. The list is the page here, and the detail is what should arrive on
 * demand.
 *
 * Nothing about a plugin is re-modelled. The section panes come from the same
 * `PluginSectionPane` the desktop shell renders, the controls row is the same
 * `PluginSectionToolbar` (in its `stacked` shape), the detail is the same
 * `PluginDetailPane`, and every dialog host is the same one the desktop panel
 * mounts. A row can never say one thing here and another on the desktop.
 *
 * This is also what `/me/plugins` renders. That route used to carry a separate
 * 94-line panel whose only affordance was an enable switch, with no install,
 * permissions, configuration or uninstall, and no code shared with `/plugins`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon } from "lucide-react"

import { PluginBatchActionsBar } from "@/components/plugins/plugin-batch-actions-bar"
import { PluginConflictDialog } from "@/components/plugins/dialogs/plugin-conflict-dialog"
import { PluginDeleteDialogHost } from "@/components/plugins/dialogs/plugin-delete-dialog-host"
import { PluginDetailPane } from "@/components/plugins/detail/plugin-detail-pane"
import { PluginFilterSheet } from "@/components/plugins/dialogs/plugin-filter-sheet"
import { PluginImportDialog } from "@/components/plugins/dialogs/plugin-import-dialog"
import { PluginPermissionReview } from "@/components/plugins/plugin-permission-review"
import { PluginRollbackDialog } from "@/components/plugins/dialogs/plugin-rollback-dialog"
import { PluginUpdateDialog } from "@/components/plugins/dialogs/plugin-update-dialog"
import { PluginPanelToolbar } from "@/components/plugins/plugin-panel-toolbar"
import {
  PluginSectionControls,
  PluginSectionPane,
  pluginSectionHasControls,
  useVisiblePluginSection,
} from "@/components/plugins/plugin-section-pane"
import { visiblePluginSections } from "@/components/plugins/plugin-nav-config"
import { ScrollShadowRow } from "@/components/plugins/scroll-shadow-row"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  PluginsViewProvider,
  useDevtoolsGate,
  usePluginMarketplace,
  usePluginRegistrySync,
  usePluginRow,
} from "@/hooks/plugins"
import { isMirroredPluginClient } from "@/lib/plugin/core/set-plugin-enabled-for-host"
import { isTauri } from "@/lib/platform/detect"
import { usePluginsStore, type PluginNavSection } from "@/stores/plugins"

export interface PluginsMobileBodyProps {
  /**
   * `/me/plugins` renders this inside `SubPageShell`, which already supplies a
   * title and the back arrow. Two headers stacked is the usual outcome of
   * reusing a page body under a shell that is also a page.
   */
  showHeader?: boolean
}

export function PluginsMobileBody({ showHeader = true }: PluginsMobileBodyProps = {}) {
  return (
    <PluginsViewProvider>
      <PluginsMobileBodyInner showHeader={showHeader} />
    </PluginsViewProvider>
  )
}

function PluginsMobileBodyInner({ showHeader }: { showHeader: boolean }) {
  const t = useTranslations("plugins")
  const tSections = useTranslations("plugins.sections")
  const tMobile = useTranslations("plugins.mobile")

  const activeSection = usePluginsStore((s) => s.activeSection)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const visibleSection = useVisiblePluginSection(activeSection)
  const devtoolsEnabled = useDevtoolsGate()
  const sections = visiblePluginSections({ devtoolsEnabled, isDesktop: isTauri() })

  const detailPluginId = usePluginsStore((s) => s.detailPluginId)
  const closeDetail = usePluginsStore((s) => s.closeDetail)
  const rollbackTarget = usePluginsStore((s) => s.rollbackTarget)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const [updateOpen, setUpdateOpen] = useState(false)

  const market = usePluginMarketplace({ autoLoad: false })
  const { syncing, sync } = usePluginRegistrySync(market.refresh)

  /**
   * The drawer opens on a CHANGE of selection, not on selection itself.
   *
   * `detailPluginId` survives navigation, because it is what the desktop pane
   * reopens on. Deriving `open` from it would pop the drawer every time the
   * user comes back to this page. Closing clears the selection so tapping the
   * same row again counts as a change once more.
   */
  const [detailOpen, setDetailOpen] = useState(false)
  const [seenDetailId, setSeenDetailId] = useState(detailPluginId)
  if (detailPluginId !== seenDetailId) {
    setSeenDetailId(detailPluginId)
    if (detailPluginId) setDetailOpen(true)
  }

  return (
    // The wallpaper only paints inside a `[data-bg-target]` subtree, and
    // `FeaturePageShell` (which owns the marker on desktop) is not in this
    // branch. Without this the page is blank behind the content whenever a
    // wallpaper is enabled.
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="plugins-mobile-body"
    >
      <PluginPermissionReview />
      <PluginDeleteDialogHost />
      <PluginImportDialog />
      <PluginConflictDialog />
      <PluginUpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} />
      <PluginRollbackDialog
        open={rollbackTarget !== null}
        pluginId={rollbackTarget}
        onClose={() => setRollbackTarget(null)}
      />
      <PluginFilterSheet />
      <PluginBatchActionsBar />

      {showHeader ? (
        <header className="safe-area-pt flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t("title")}</h1>
          <RefreshCatalogButton syncing={syncing} onSync={sync} label={tMobile("refresh")} />
        </header>
      ) : (
        // Under `SubPageShell` the title and back arrow already exist, but the
        // refresh still has to be reachable.
        <div className="flex shrink-0 justify-end border-b px-2 py-1.5">
          <RefreshCatalogButton syncing={syncing} onSync={sync} label={tMobile("refresh")} />
        </div>
      )}

      {/* Says what a queued toggle actually promises. On this host the plugin
          runtime lives on the paired desktop, so "enabled" here means "the
          desktop will enable it", which is a different claim. */}
      {isMirroredPluginClient() ? (
        <p
          className="shrink-0 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="plugins-mobile-mirrored-hint"
        >
          {tMobile("mirroredHint")}
        </p>
      ) : null}

      <div className="shrink-0 border-b px-2 py-1.5">
        <ScrollShadowRow testId="plugins-mobile-sections">
          <ToggleGroup
            type="single"
            value={visibleSection}
            onValueChange={(value) => {
              if (value) setActiveSection(value as PluginNavSection)
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label={tMobile("sectionsAria")}
            className="w-max"
          >
            {sections.map(({ section, labelKey, icon: Icon, disabled }) => (
              <ToggleGroupItem
                key={section}
                value={section}
                disabled={disabled}
                title={disabled ? tSections("desktopOnlyHint") : undefined}
                className="h-8 gap-1.5 px-2.5 text-xs"
                data-testid={`plugins-mobile-section-${section}`}
                data-disabled-reason={disabled ? "desktop" : undefined}
              >
                <Icon className="size-3.5 shrink-0" />
                {tSections(labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </ScrollShadowRow>
      </div>

      {pluginSectionHasControls(visibleSection) ? (
        <div className="shrink-0 border-b px-2 py-2">
          <PluginSectionControls section={visibleSection} layout="stacked" />
        </div>
      ) : null}

      {visibleSection === "library" ? (
        <div className="shrink-0 border-b px-2 py-1.5">
          <PluginPanelToolbar onCheckUpdates={() => setUpdateOpen(true)} />
        </div>
      ) : null}

      {/*
        No PullToRefresh here on purpose. Every section pane owns its own
        scroller, and PTR's wrapper only fires while ITS OWN scrollTop is 0,
        which it always is when the scrolling happens a level down. The gesture
        would then trigger from anywhere in the list. The header's refresh
        button asks the same question without the misfire.
      */}
      <div className="min-h-0 flex-1">
        <PluginSectionPane section={visibleSection} />
      </div>

      <MobilePluginDetail
        pluginId={detailPluginId}
        open={detailOpen}
        onOpenChange={(next) => {
          setDetailOpen(next)
          if (!next) closeDetail()
        }}
        fallbackTitle={tSections("detailSheetLabel")}
      />
    </div>
  )
}

function RefreshCatalogButton({
  syncing,
  onSync,
  label,
}: {
  syncing: boolean
  onSync: () => Promise<void>
  label: string
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8"
      aria-label={label}
      disabled={syncing}
      onClick={() => void onSync()}
      data-testid="plugins-mobile-refresh"
    >
      <RefreshCwIcon className={syncing ? "size-4 animate-spin" : "size-4"} />
    </Button>
  )
}

interface MobilePluginDetailProps {
  pluginId: string | null
  open: boolean
  onOpenChange: (next: boolean) => void
  fallbackTitle: string
}

function MobilePluginDetail({
  pluginId,
  open,
  onOpenChange,
  fallbackTitle,
}: MobilePluginDetailProps) {
  const rowState = usePluginRow(pluginId ?? "")
  const title = rowState.state === "ready" ? rowState.row.name : fallbackTitle

  return (
    <ResponsiveDetailSheet
      open={open && pluginId !== null}
      onOpenChange={onOpenChange}
      title={title}
    >
      {/*
        The drawer caps itself at 85vh and `PluginDetailPane` is `h-full` with
        its own scroller, so a bounded box between the two gives that scroller
        something definite to resolve against.
      */}
      <div className="h-[70vh] min-h-0">
        <PluginDetailPane />
      </div>
    </ResponsiveDetailSheet>
  )
}
