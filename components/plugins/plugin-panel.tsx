"use client"

// /plugins panel — main user-facing surface for plugin management.
//
// Shell powered by `FeaturePageShell`:
//   - **Left**   PluginNavSidebar: the sections (Library / Discover / Agent
//                packages / Governance / Devtools) and, under Library, its
//                capability facets. One rail, not two side by side.
//   - **Center** Switches on `activeSection`.
//   - **Right**  `PluginDetailPane` for the selected plugin, ONLY while one is
//                selected and only in sections whose rows are plugins
//                (Library, Governance). With nothing selected the list takes
//                the whole width: a third of the window reserved for "select
//                a plugin" is a third the list could have used. It closes from
//                its own close button or Escape. Below `lg` the right pane is
//                the shell's overlay Sheet, opened by the selection.
//
// Dialog hosts (delete, permission review, import, conflict, update,
// rollback) are mounted once at the root.
//
// URL deep links (`?section=` / `?sub=` / `?gov=` / `?subtab=` / `?plugin=`
// and legacy `?tab=`) are applied by `usePluginsUrlSync`, the same hook the
// phone body runs, so a link lands identically on both shells.

import { useEffect, useState } from "react"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { usePluginsStore } from "@/stores/plugins"
import { usePluginMarketplace, usePluginRegistrySync, PluginsViewProvider } from "@/hooks/plugins"
import { usePluginsUrlSync } from "@/hooks/plugins/use-plugins-url-sync"
import { useTranslations } from "next-intl"
import { PlugIcon } from "lucide-react"
import { useBreakpoint } from "@/hooks/ui"
import { isTauri } from "@/lib/tauri"

import { PLUGIN_RAIL_WIDTH } from "./plugin-rail-width"
import { pluginNavItem } from "./plugin-nav-config"
import type { PluginNavSection } from "@/stores/plugins"
import { Badge } from "@/components/ui/badge"

// Dialog hosts — all driven by store targets, mounted once at the panel root.
import { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
import { PluginFilterSheet } from "./dialogs/plugin-filter-sheet"
import { PluginDeleteDialogHost } from "./dialogs/plugin-delete-dialog-host"
import { PluginPermissionReview } from "./plugin-permission-review"
import { PluginImportDialog } from "./dialogs/plugin-import-dialog"
import { PluginConflictDialog } from "./dialogs/plugin-conflict-dialog"
import { PluginUpdateDialog } from "./dialogs/plugin-update-dialog"
import { PluginRollbackDialog } from "./dialogs/plugin-rollback-dialog"
import { PluginExtensionSlot } from "./plugin-extension-slot"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"

// 3-pane shell pieces.
import { PluginNavSidebar } from "./plugin-nav-sidebar"
import { PluginPanelToolbar } from "./plugin-panel-toolbar"
import { PluginDetailPane } from "./detail/plugin-detail-pane"
import {
  PluginSectionControls,
  PluginSectionPane,
  pluginSectionHasControls,
  useVisiblePluginSection,
} from "./plugin-section-pane"

/**
 * The rule the nav rail disables Agent packages by: a `desktop` section is not
 * selectable off the Tauri shell, so a `?section=agent-packages` link on the
 * web build must not select it either (it used to land on a section the rail
 * shows as disabled). Module-level so the predicate is stable.
 */
function isDesktopSectionAllowed(section: PluginNavSection): boolean {
  return isTauri() || pluginNavItem(section).featureFlag !== "desktop"
}

export function PluginPanel() {
  usePluginsUrlSync({ isSectionAllowed: isDesktopSectionAllowed })

  const updateDialog = usePluginsStore((s) => s.updateDialog)
  const openUpdateDialog = usePluginsStore((s) => s.openUpdateDialog)
  const closeUpdateDialog = usePluginsStore((s) => s.closeUpdateDialog)
  const rollbackTarget = usePluginsStore((s) => s.rollbackTarget)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)

  // The panel only needs the imperative `refresh()` for the Sync Registry
  // button, it never renders search/featured results itself. Opt out of the
  // on-mount auto-search so entering /plugins from the sidebar (which lands on
  // the Library section) doesn't fire a marketplace search. The Discover /
  // marketplace surfaces keep their own auto-loading hook instances.
  const market = usePluginMarketplace({ autoLoad: false })
  const { syncing, sync } = usePluginRegistrySync(market.refresh)

  const dialogHosts = (
    <>
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
      <PluginBatchActionsBar />
    </>
  )

  return (
    <PluginsViewProvider>
      {dialogHosts}
      <NewShellLayout
        onCheckUpdates={() => openUpdateDialog()}
        onSyncRegistry={sync}
        syncing={syncing}
      />
    </PluginsViewProvider>
  )
}

interface NewShellLayoutProps {
  onCheckUpdates: () => void
  onSyncRegistry: () => Promise<void>
  syncing: boolean
}

function NewShellLayout({ onCheckUpdates, onSyncRegistry, syncing }: NewShellLayoutProps) {
  const t = useTranslations("plugins.sections")
  const tPage = useTranslations("plugins")
  const activeSection = usePluginsStore((s) => s.activeSection)
  const visibleSection = useVisiblePluginSection(activeSection)
  // The active section rides beside the title as a badge (the `status` slot),
  // not as `context` text after the description — a trailing "· Library" read
  // as a stray fragment whenever the description truncated. The rail icon is
  // mirrored so the badge and the selected nav row share one glyph.
  const SectionIcon = pluginNavItem(visibleSection).icon

  // Below `lg` the shell moves the detail pane into a Sheet, and an
  // uncontrolled Sheet only opens from its own 16px panel icon. Clicking a
  // plugin's name (or "Open details" in its row menu) only writes
  // `detailPluginId` to the store, so on a tablet-width window — a normal size
  // for the desktop app — both paths ticked the row and showed nothing. The
  // sheet is therefore driven by the selection, with the same rule the phone
  // body uses: it opens on a CHANGE of selection, not on selection itself.
  // `detailPluginId` survives navigation (it is what the full-width pane
  // reopens on), so deriving `open` from it directly would pop the sheet every
  // time the user comes back. Dismissing the sheet clears the selection, so
  // clicking the same plugin again counts as a change once more. At `lg` and
  // up the pane is inline and the shell ignores `open` / `onOpenChange`.
  const detailPluginId = usePluginsStore((s) => s.detailPluginId)
  const closeDetail = usePluginsStore((s) => s.closeDetail)
  // Inline pane (>= lg) vs overlay sheet (tablet). The inline pane closes
  // from its own header button; the sheet from its corner button, which the
  // pane keeps clear (it used to sit on the plugin's name). The sheet covers
  // the list, so it also steps aside when the pane changes the list's filters.
  const inlineDetail = useBreakpoint() === "desktop"
  const [detailSheetOpen, setDetailSheetOpen] = useState(false)
  const [seenDetailId, setSeenDetailId] = useState(detailPluginId)
  if (detailPluginId !== seenDetailId) {
    setSeenDetailId(detailPluginId)
    if (detailPluginId) setDetailSheetOpen(true)
  }
  const handleDetailSheetOpenChange = (next: boolean) => {
    setDetailSheetOpen(next)
    if (!next && detailPluginId) closeDetail()
  }

  // Second header tier — one control vocabulary for every section. Each
  // section supplies its own segments/tools through `PluginSectionToolbar`
  // rather than inventing a picker of its own (see that component's note).
  // The mapping itself lives in `plugin-section-pane.tsx` so the phone body
  // renders the same sections from the same source.
  // Escape closes the inline detail, the keyboard twin of its close button.
  // Not while focus is typing (a search box owns its own Escape) and not when
  // something else already handled the key (an open menu or dialog does).
  useEffect(() => {
    if (!inlineDetail || !detailPluginId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"]')) return
      closeDetail()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [inlineDetail, detailPluginId, closeDetail])

  // Sections whose rows are plugins get the detail pane; Discover lists
  // registry entries (its own sheet shows those), Devtools needs the full
  // width, and Agent packages lists Pi packages, which have no plugin row.
  const sectionHasDetail = visibleSection === "library" || visibleSection === "governance"
  const showDetailPane = sectionHasDetail && detailPluginId !== null

  const controls = pluginSectionHasControls(visibleSection) ? (
    <PluginSectionControls section={visibleSection} />
  ) : undefined

  return (
    <FeaturePageShell
      storageId="plugins"
      header={
        <FeaturePageHeader
          icon={<PlugIcon />}
          title={tPage("title")}
          description={tPage("description")}
          status={
            <Badge
              variant="secondary"
              className="h-5 gap-1 px-1.5 text-[10px] font-normal"
              data-testid="plugin-section-badge"
            >
              <SectionIcon aria-hidden />
              {t(visibleSection)}
            </Badge>
          }
          controls={controls}
          actions={
            visibleSection === "library" ? (
              <PluginPanelToolbar
                onCheckUpdates={onCheckUpdates}
                onSyncRegistry={onSyncRegistry}
                syncing={syncing}
              />
            ) : undefined
          }
        />
      }
      leftPane={{
        label: t("library"),
        content: <PluginNavSidebar />,
        // Pinned, not proportional. Its rows are short labels ("已安装" /
        // Discover / Governance), so a percentage column grows with the window
        // for no reason and, worse, drifts away from the Library's capability
        // rail immediately to its right, which is a fixed Tailwind width. One
        // constant in the unit both mechanisms accept keeps the two rails equal
        // at every window size. The bounds are lengths too: a percentage max
        // would clamp the pinned default below itself on a narrow window.
        defaultSize: PLUGIN_RAIL_WIDTH,
        minSize: "10rem",
        maxSize: "20rem",
      }}
      // The right pane exists only while it has something to show. Moving
      // between "selected" and "not selected" changes the pane count, which
      // re-lays out the group at its default split; widths are not persisted
      // (see `FeaturePageShell`), so no user choice is lost by it.
      rightPane={
        !showDetailPane
          ? undefined
          : {
              label: t("detailSheetLabel"),
              // 38% at 1440 is ~520px: wide enough for the tab bar's five
              // labels and the Overview's single column, while the list (now
              // the only thing in the center, the capability facets having
              // moved into the nav rail) keeps ~650px, above the `@md` gate
              // its rows put the version and permission count back on. The
              // Overview turns two-column at 42rem, i.e. dragged to ~48%; the
              // cap of 56% still leaves the list a usable column.
              content: inlineDetail ? (
                <PluginDetailPane onClose={closeDetail} />
              ) : (
                // The sheet draws its own corner close button; the pane keeps
                // that corner clear instead of drawing a second one under it.
                <PluginDetailPane
                  reserveCloseCorner
                  onFilterApplied={() => handleDetailSheetOpenChange(false)}
                />
              ),
              // The tablet sheet reads at a phone-like width otherwise (320px).
              mobileWidthClass: "w-[min(30rem,92vw)] sm:max-w-none",
              open: detailSheetOpen,
              onOpenChange: handleDetailSheetOpenChange,
              defaultSize: 38,
              minSize: 28,
              maxSize: 56,
            }
      }
    >
      <PluginSectionPane section={visibleSection} />
      <PluginExtensionSlot point="settings.plugins" className="border-t px-4 py-3 empty:hidden" />
    </FeaturePageShell>
  )
}

/** Whether a key event's target is a text-entry control that owns Escape. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}
