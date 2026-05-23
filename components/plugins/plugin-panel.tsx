"use client"

// /plugins panel — main user-facing surface for plugin management.
//
// 3-pane shell powered by `FeaturePageShell`:
//   - **Left**  PluginNavSidebar (Library / Discover / Governance /
//               Devtools — Devtools gated by `useDevtoolsGate`)
//   - **Center** Switches on `activeSection`: Library / Discover /
//               Governance / Devtools panes
//   - **Right** Persistent `PluginDetailPane` showing the selected plugin's
//               5-tab detail (Overview / Capabilities / Configure /
//               Permissions / Data). On narrow viewports the right pane
//               collapses into FeaturePageShellMobile's Sheet trigger.
//
// Dialog hosts (delete, permission review, configure form, import,
// conflict, update, rollback) are mounted once at the root.
//
// URL deep links: `?section=` / `?sub=` / `?gov=` / `?subtab=` drive the
// new layout. Legacy `?tab=` deep links are still accepted as a
// back-compat shim — `setActiveTab` mirrors the value into
// `activeSection`, so external surfaces that have not yet migrated their
// links keep working.

import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import {
  usePluginsStore,
  type PluginDetailSubTab,
  type PluginGovernanceView,
  type PluginLibrarySubFilter,
  type PluginNavSection,
  type PluginPanelTab,
} from "@/stores/plugins"
import { deletePlugin, listPlugins, updatePlugin } from "@/lib/db/plugins"
import { getDb } from "@/lib/db/schema"
import { usePluginMarketplace } from "@/hooks/plugins"
import { useTranslations } from "next-intl"

// Dialog hosts — all driven by store targets, mounted once at the panel root.
import { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
import { PluginFilterSheet } from "./dialogs/plugin-filter-sheet"
import { PluginDeleteDialog } from "./dialogs/plugin-delete-dialog"
import { PluginPermissionReview } from "./plugin-permission-review"
import { PluginConfigForm } from "./detail/plugin-config-form"
import { PluginImportDialog } from "./dialogs/plugin-import-dialog"
import { PluginConflictDialog } from "./dialogs/plugin-conflict-dialog"
import { PluginUpdateDialog } from "./dialogs/plugin-update-dialog"
import { PluginRollbackDialog } from "./dialogs/plugin-rollback-dialog"
import { PluginExtensionSlot } from "./plugin-extension-slot"

// 3-pane shell pieces.
import { PluginNavSidebar } from "./plugin-nav-sidebar"
import { PluginLibraryPane } from "./library/plugin-library-pane"
import { PluginLibraryHeader } from "./library/plugin-library-header"
import { PluginDiscoverPane } from "./discover/plugin-discover-pane"
import { PluginGovernancePane } from "./governance/plugin-governance-pane"
import { PluginDevtoolsPane } from "./devtools/plugin-devtools-pane"
import { PluginDetailPane } from "./detail/plugin-detail-pane"

const VALID_TABS: ReadonlySet<PluginPanelTab> = new Set([
  "installed",
  "browse",
  "configure",
  "permissions",
  "scheduled",
  "analytics",
  "devtools",
])
const VALID_SECTIONS: ReadonlySet<PluginNavSection> = new Set([
  "library",
  "discover",
  "governance",
  "devtools",
])
const VALID_LIBRARY_SUB: ReadonlySet<PluginLibrarySubFilter> = new Set([
  "all",
  "enabled",
  "updates",
  "configurable",
  "errored",
])
const VALID_GOVERNANCE: ReadonlySet<PluginGovernanceView> = new Set([
  "permissions",
  "scheduled",
  "analytics",
  "audit",
])
const VALID_DETAIL_SUBTAB: ReadonlySet<PluginDetailSubTab> = new Set([
  "overview",
  "capabilities",
  "configure",
  "permissions",
  "data",
])

function isValidTab(value: string | null): value is PluginPanelTab {
  return value !== null && VALID_TABS.has(value as PluginPanelTab)
}

function isValidSection(value: string | null): value is PluginNavSection {
  return value !== null && VALID_SECTIONS.has(value as PluginNavSection)
}

export function PluginPanel() {
  const activeTab = usePluginsStore((s) => s.activeTab)
  const setActiveTab = usePluginsStore((s) => s.setActiveTab)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const setLibrarySubFilter = usePluginsStore((s) => s.setLibrarySubFilter)
  const setGovernanceView = usePluginsStore((s) => s.setGovernanceView)
  const setDetailSubTab = usePluginsStore((s) => s.setDetailSubTab)

  // URL sync — extend the legacy `?tab=` deep-link with `?section=`,
  // `?sub=`, `?gov=`, `?subtab=` so external surfaces can choose either
  // vocabulary. We adopt the URL value on mount AND whenever the URL
  // changes; local clicks don't touch the URL, so this effect stays a
  // no-op for in-app navigation.
  const searchParams = useSearchParams()
  const requestedTabParam = searchParams?.get("tab") ?? null
  const requestedSectionParam = searchParams?.get("section") ?? null
  const requestedSubParam = searchParams?.get("sub") ?? null
  const requestedGovParam = searchParams?.get("gov") ?? null
  const requestedSubtabParam = searchParams?.get("subtab") ?? null

  useEffect(() => {
    if (isValidTab(requestedTabParam) && requestedTabParam !== activeTab) {
      // setActiveTab also mirrors into activeSection / governanceView via
      // deriveSectionFromTab, so legacy deep links land both layouts.
      setActiveTab(requestedTabParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTabParam])

  useEffect(() => {
    if (isValidSection(requestedSectionParam)) {
      setActiveSection(requestedSectionParam)
    }
    if (
      requestedSubParam !== null &&
      VALID_LIBRARY_SUB.has(requestedSubParam as PluginLibrarySubFilter)
    ) {
      setLibrarySubFilter(requestedSubParam as PluginLibrarySubFilter)
    }
    if (
      requestedGovParam !== null &&
      VALID_GOVERNANCE.has(requestedGovParam as PluginGovernanceView)
    ) {
      setGovernanceView(requestedGovParam as PluginGovernanceView)
    }
    if (
      requestedSubtabParam !== null &&
      VALID_DETAIL_SUBTAB.has(requestedSubtabParam as PluginDetailSubTab)
    ) {
      setDetailSubTab(requestedSubtabParam as PluginDetailSubTab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSectionParam, requestedSubParam, requestedGovParam, requestedSubtabParam])

  const [updateOpen, setUpdateOpen] = useState(false)
  const rollbackTarget = usePluginsStore((s) => s.rollbackTarget)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)

  const market = usePluginMarketplace()
  const [syncing, setSyncing] = useState(false)
  // syncRegistry: refresh the marketplace catalog and stamp every installed
  // plugin with `manifest.updateAvailable` if the catalog reports a newer
  // version. The flag is consumed by the `hasUpdate` filter and the
  // PluginPanelGrid badge surface.
  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      await market.refresh()
      const rows = await listPlugins()
      const mod = (await import("@/lib/plugin/package/marketplace")) as unknown as {
        getPluginMarketplace: () => {
          checkForUpdates: (
            installed: { id: string; version: string }[]
          ) => Promise<{ id: string; latestVersion: string }[]>
        }
      }
      const updates = await mod
        .getPluginMarketplace()
        .checkForUpdates(rows.map((r) => ({ id: r.id, version: r.version })))
      const updateIds = new Set(updates.map((u) => u.id))
      await Promise.all(
        rows.map((row) => {
          const wantsFlag = updateIds.has(row.id)
          const currentFlag = !!(row.manifest as { updateAvailable?: boolean }).updateAvailable
          if (wantsFlag === currentFlag) return Promise.resolve()
          return updatePlugin(row.id, {
            manifest: { ...row.manifest, updateAvailable: wantsFlag },
          })
        })
      )
    } finally {
      setSyncing(false)
    }
  }, [market])

  const dialogHosts = (
    <>
      <PluginPermissionReview />
      <PluginConfigForm />
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
    </>
  )

  return (
    <>
      {dialogHosts}
      <NewShellLayout
        onCheckUpdates={() => setUpdateOpen(true)}
        onSyncRegistry={handleSync}
        syncing={syncing}
      />
    </>
  )
}

interface NewShellLayoutProps {
  onCheckUpdates: () => void
  onSyncRegistry: () => Promise<void>
  syncing: boolean
}

function NewShellLayout({ onCheckUpdates, onSyncRegistry, syncing }: NewShellLayoutProps) {
  const t = useTranslations("plugins.sections")
  const activeSection = usePluginsStore((s) => s.activeSection)

  const toolbar =
    activeSection === "library" ? (
      <PluginLibraryHeader
        onCheckUpdates={onCheckUpdates}
        onSyncRegistry={onSyncRegistry}
        syncing={syncing}
      />
    ) : (
      <SectionHeader />
    )

  const center =
    activeSection === "library" ? (
      <PluginLibraryPane />
    ) : activeSection === "discover" ? (
      <PluginDiscoverPane />
    ) : activeSection === "governance" ? (
      <PluginGovernancePane />
    ) : (
      <PluginDevtoolsPane />
    )

  return (
    <FeaturePageShell
      storageId="plugins"
      toolbar={toolbar}
      leftPane={{
        label: t("library"),
        content: <PluginNavSidebar />,
        defaultSize: 18,
        minSize: 14,
        maxSize: 26,
      }}
      rightPane={{
        label: t("detailSheetLabel"),
        content: <PluginDetailPane />,
        defaultSize: 38,
        minSize: 28,
        maxSize: 50,
      }}
    >
      {center}
      <PluginExtensionSlot point="settings.plugins" className="border-t px-4 py-3 empty:hidden" />
    </FeaturePageShell>
  )
}

function SectionHeader() {
  const t = useTranslations("plugins.sections")
  const activeSection = usePluginsStore((s) => s.activeSection)
  return (
    <div className="flex w-full items-center px-2 py-1.5 text-sm font-medium">
      {t(activeSection)}
    </div>
  )
}

function PluginDeleteDialogHost() {
  const target = usePluginsStore((s) => s.deleteTarget)
  const queueLength = usePluginsStore((s) => s.deleteQueue.length)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const advanceDeleteQueue = usePluginsStore((s) => s.advanceDeleteQueue)
  // After confirm / cancel, advance to the next queued target so a batch
  // uninstall walks the whole selection without re-opening the bar.
  const advance = () => {
    if (queueLength > 0) advanceDeleteQueue()
    else setDeleteTarget(null)
  }
  return (
    <PluginDeleteDialog
      open={target !== null}
      pluginName={target?.name ?? ""}
      onCancel={advance}
      onConfirm={async ({ cascade }) => {
        if (!target) return
        const id = target.pluginId
        await deletePlugin(id)
        if (cascade) {
          const db = getDb()
          await Promise.all([
            db.pluginPermissions.where("pluginId").equals(id).delete(),
            db.pluginAnalytics.where("pluginId").equals(id).delete(),
            db.pluginScheduledJobs.where("pluginId").equals(id).delete(),
          ])
        }
        advance()
      }}
    />
  )
}
