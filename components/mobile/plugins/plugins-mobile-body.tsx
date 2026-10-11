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
 *
 * Vertical budget. Before the first plugin, a phone used to spend ~45% of the
 * screen on chrome: title, section chips, search, segments + tools, a row of
 * five icon-only toolbar buttons, a "Categories" row and a select-all row.
 * Now:
 *   - the Library's actions sit in the title row (Install, the cogset, and an
 *     overflow menu with labels, `PluginPanelToolbar layout="compact"`);
 *   - Categories and selection share the list's one head bar
 *     (`plugin-library-list.tsx`), and checkboxes appear only in selection
 *     mode;
 * so the list starts right after the section chips and the search controls.
 *
 * The detail drawer is nearly full height, is titled by the plugin (for
 * assistive tech; the pane's own header shows it), and closes from the pane's
 * close button as well as by swipe: a drawer with no visible close control
 * left a user who does not know the gesture with only the overlay to tap.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
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
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import {
  PluginSectionControls,
  PluginSectionPane,
  pluginSectionHasControls,
  useVisiblePluginSection,
} from "@/components/plugins/plugin-section-pane"
import { pluginNavItem, visiblePluginSections } from "@/components/plugins/plugin-nav-config"
import { ScrollShadowRow } from "@/components/plugins/scroll-shadow-row"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  PluginsViewProvider,
  useDevtoolsGate,
  usePluginMarketplace,
  usePluginRegistrySync,
} from "@/hooks/plugins"
import { usePluginsUrlSync } from "@/hooks/plugins/use-plugins-url-sync"
import { isMirroredPluginClient } from "@/lib/plugin/core/set-plugin-enabled-for-host"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import { isTauri } from "@/lib/platform/detect"
import { COMPACT_ABOVE_TAB_BAR_BOTTOM } from "@/lib/shell/compact-shell"
import { cn } from "@/lib/utils"
import { usePluginsStore, type PluginNavSection } from "@/stores/plugins"

export interface PluginsMobileBodyProps {
  /**
   * `/me/plugins` renders this inside `SubPageShell`, which already supplies a
   * title and the back arrow. Two headers stacked is the usual outcome of
   * reusing a page body under a shell that is also a page.
   */
  showHeader?: boolean
}

/**
 * The same rule `visiblePluginSections` disables the toggle chips by: a
 * `desktop` section is not selectable off the Tauri shell. Module-level so the
 * predicate handed to the URL sync is stable.
 */
function isMobileSectionAllowed(section: PluginNavSection): boolean {
  return isTauri() || pluginNavItem(section).featureFlag !== "desktop"
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

  // Same deep-link handling as the desktop panel (`?plugin=`, `?section=`, …),
  // minus the sections this shell disables: a link must not select a section
  // the toggle row refuses to.
  usePluginsUrlSync({ isSectionAllowed: isMobileSectionAllowed })

  const detailPluginId = usePluginsStore((s) => s.detailPluginId)
  const closeDetail = usePluginsStore((s) => s.closeDetail)
  const rollbackTarget = usePluginsStore((s) => s.rollbackTarget)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const updateDialog = usePluginsStore((s) => s.updateDialog)
  const openUpdateDialog = usePluginsStore((s) => s.openUpdateDialog)
  const closeUpdateDialog = usePluginsStore((s) => s.closeUpdateDialog)

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
      <PluginUpdateDialog
        open={updateDialog !== null}
        pluginId={updateDialog?.pluginId ?? null}
        onClose={closeUpdateDialog}
      />
      <PluginRollbackDialog
        open={rollbackTarget !== null}
        pluginId={rollbackTarget}
        onClose={() => setRollbackTarget(null)}
      />
      <PluginFilterSheet />
      {/* The bar is `fixed` and shared with the desktop panel, where its
          safe-area-only offset is correct. Here it is not: both routes that
          mount this body (`/plugins` and `/me/plugins`) keep `MobileTabBar`
          on screen, so the default offset parks the bar inside the tab bar's
          band and covers the bottom navigation. */}
      <PluginBatchActionsBar className={COMPACT_ABOVE_TAB_BAR_BOTTOM} />

      {/* The title row carries the section's actions. On the Library that is
          the compact toolbar (Install, cogset, overflow with Check updates and
          the registry sync); every other section gets the catalog refresh.
          Under `SubPageShell` the title and back arrow already exist, so the
          same actions get a row of their own. */}
      {showHeader ? (
        <header className="safe-area-pt flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t("title")}</h1>
          <SectionActions
            library={visibleSection === "library"}
            syncing={syncing}
            onSync={sync}
            onCheckUpdates={() => openUpdateDialog()}
            refreshLabel={tMobile("refresh")}
          />
        </header>
      ) : (
        <div
          className="flex shrink-0 items-center justify-end gap-2 border-b px-2 py-1.5"
          data-testid="plugins-mobile-actions-row"
        >
          <SectionActions
            library={visibleSection === "library"}
            syncing={syncing}
            onSync={sync}
            onCheckUpdates={() => openUpdateDialog()}
            refreshLabel={tMobile("refresh")}
          />
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
              if (!value) return
              // A desktop-only chip stays tappable so it can say why it will
              // not open. Disabled, a tap did nothing, and the reason lived
              // in a `title` a phone never shows.
              if (sections.find((item) => item.section === value)?.disabled) {
                toast.info(tSections("desktopOnlyHint"))
                return
              }
              setActiveSection(value as PluginNavSection)
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
                aria-disabled={disabled || undefined}
                title={disabled ? tSections("desktopOnlyHint") : undefined}
                className={cn(
                  "h-8 gap-1.5 px-2.5 text-xs pointer-coarse:h-10",
                  disabled && "opacity-50"
                )}
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
      {/* Plugins extend this page through the same slot the desktop panel
          mounts; it used to be desktop-only. */}
      <PluginExtensionSlot point="settings.plugins" className="shrink-0 border-t px-3 py-2 empty:hidden" />

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

function SectionActions({
  library,
  syncing,
  onSync,
  onCheckUpdates,
  refreshLabel,
}: {
  library: boolean
  syncing: boolean
  onSync: () => Promise<void>
  onCheckUpdates: () => void
  refreshLabel: string
}) {
  // One refresh, not two: on the Library the toolbar's overflow carries the
  // registry sync; every other section gets the refresh button.
  return library ? (
    <PluginPanelToolbar
      layout="compact"
      onCheckUpdates={onCheckUpdates}
      onSyncRegistry={onSync}
      syncing={syncing}
    />
  ) : (
    <RefreshCatalogButton syncing={syncing} onSync={onSync} label={refreshLabel} />
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
      className="size-10"
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
  // The plugin's name titles the drawer for assistive tech. It is visually
  // hidden because `PluginDetailHeader` opens the pane with the name, version
  // and avatar; a visible drawer title above that printed it twice and spent
  // a row of a phone screen on it.
  const name = usePluginDisplayName(pluginId)
  const close = () => onOpenChange(false)
  return (
    <ResponsiveDetailSheet
      open={open && pluginId !== null}
      onOpenChange={onOpenChange}
      title={name || fallbackTitle}
      headerVisuallyHidden
      // Nearly full height: the pane has a tab bar now, and every tab wants
      // the room. 92dvh still leaves the page visibly behind the drawer.
      contentClassName="h-[92dvh] max-h-[92dvh] data-[vaul-drawer-direction=bottom]:max-h-[92dvh]"
    >
      {/*
        The drawer is a flex column; this box takes what is left under its
        drag handle and gives the pane's own scroller something definite to
        resolve against. The bottom inset keeps the last row clear of the home
        indicator.
      */}
      <div
        className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]"
        data-testid="plugins-mobile-detail-body"
      >
        <PluginDetailPane onClose={close} onFilterApplied={close} />
      </div>
    </ResponsiveDetailSheet>
  )
}
