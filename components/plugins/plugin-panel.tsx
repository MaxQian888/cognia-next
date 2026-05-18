"use client"

// /plugins panel — main user-facing surface for plugin management.
//
// Tab composition: every one of the 7 tabs mounts a full-fidelity surface
// backed by a dedicated component under components/plugins/. Dialog hosts
// stack at the panel root and listen to the shared zustand store, so a
// single panel instance handles delete / detail / permission-review /
// configure / import / conflict / update / rollback / install-from-url
// flows without prop drilling.
//
// Responsive composition:
//   * `md:` flips the header into a horizontal layout
//   * `< lg:` swaps the desktop category rail for a Sheet trigger
//   * tab strip is horizontally scrollable at every viewport
//   * detail Sheet widens through `lg:` and `xl:` breakpoints

import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePluginsStore, type PluginPanelTab } from "@/stores/plugins"
import { deletePlugin, listPlugins, updatePlugin } from "@/lib/db/plugins"
import { getDb } from "@/lib/db/schema"
import { usePluginMarketplace } from "@/hooks/plugins"
import { PluginPanelTabs } from "./plugin-panel-tabs"
import { PluginPanelToolbar } from "./plugin-panel-toolbar"
import { PluginPanelGrid } from "./plugin-panel-grid"
import { PluginPanelHeader } from "./plugin-panel-header"
import { PluginCategorySidebar } from "./plugin-category-sidebar"
import { PluginCategorySheet } from "./plugin-category-sheet"
import { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
import { PluginFilterSheet } from "./plugin-filter-sheet"
import { PluginDetailPanel } from "./plugin-detail-panel"
import { PluginDeleteDialog } from "./plugin-delete-dialog"
import { PluginPermissionReview } from "./plugin-permission-review"
import { PluginConfigForm } from "./plugin-config-form"
import { PluginImportDialog } from "./plugin-import-dialog"
import { PluginConflictDialog } from "./plugin-conflict-dialog"
import { PluginUpdateDialog } from "./plugin-update-dialog"
import { PluginRollbackDialog } from "./plugin-rollback-dialog"
import { PluginMarketplace } from "./plugin-marketplace"
import { PluginScheduledJobs } from "./plugin-scheduled-jobs"
import { PluginAnalytics } from "./plugin-analytics"
import { PluginDevtoolsPanel } from "./plugin-devtools-panel"
import { PluginExtensionSlot } from "./plugin-extension-slot"
import { PluginConfigureTab } from "./plugin-configure-tab"
import { PluginPermissionsTab } from "./plugin-permissions-tab"

const VALID_TABS: ReadonlySet<PluginPanelTab> = new Set([
  "installed",
  "browse",
  "configure",
  "permissions",
  "scheduled",
  "analytics",
  "devtools",
])

function isValidTab(value: string | null): value is PluginPanelTab {
  return value !== null && VALID_TABS.has(value as PluginPanelTab)
}

export function PluginPanel() {
  const activeTab = usePluginsStore((s) => s.activeTab)
  const setActiveTab = usePluginsStore((s) => s.setActiveTab)

  // Honor ?tab= deep links coming from settings or external surfaces.
  // We adopt the URL value on mount AND whenever the URL changes —
  // e.g. when the user clicks "Open marketplace" in Settings while
  // /plugins is already open in the same window. Local tab clicks
  // don't touch the URL, so re-syncing here doesn't fight the user:
  // the guard `requested !== activeTab` makes the effect a no-op when
  // the store and URL already agree, and tab clicks only flip the
  // store (`searchParams` stays stable so this effect doesn't fire).
  const searchParams = useSearchParams()
  const requestedTabParam = searchParams?.get("tab") ?? null
  useEffect(() => {
    if (isValidTab(requestedTabParam) && requestedTabParam !== activeTab) {
      setActiveTab(requestedTabParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTabParam])

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-col gap-3 border-b p-4 lg:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex-1 min-w-0">
            <PluginPanelHeader />
          </div>
          <PluginPanelToolbar
            onCheckUpdates={() => setUpdateOpen(true)}
            onSyncRegistry={handleSync}
            syncing={syncing}
          />
        </div>
      </header>

      {/* Dialog hosts — driven by store targets, mounted once. */}
      <PluginDetailPanel />
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

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as PluginPanelTab)}
        className="flex-1 min-h-0 flex flex-col"
      >
        <PluginPanelTabs className="mt-4 mx-4 lg:mx-6" />

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 lg:p-6">
            <TabsContent value="installed" className="mt-0">
              <div className="space-y-3">
                <PluginCategorySheet className="lg:hidden" />
                <div className="grid gap-4 lg:grid-cols-[14rem_1fr] xl:grid-cols-[16rem_1fr]">
                  <div className="hidden lg:block">
                    <PluginCategorySidebar />
                  </div>
                  <div className="space-y-3 min-w-0">
                    <PluginPanelGrid />
                  </div>
                </div>
              </div>
            </TabsContent>
            <TabsContent value="browse" className="mt-0">
              <PluginMarketplace />
            </TabsContent>
            <TabsContent value="configure" className="mt-0">
              <PluginConfigureTab />
            </TabsContent>
            <TabsContent value="permissions" className="mt-0">
              <PluginPermissionsTab />
            </TabsContent>
            <TabsContent value="scheduled" className="mt-0">
              <PluginScheduledJobs />
            </TabsContent>
            <TabsContent value="analytics" className="mt-0">
              <PluginAnalytics />
            </TabsContent>
            <TabsContent value="devtools" className="mt-0">
              <PluginDevtoolsPanel />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>

      {/* Plugin-contributed extensions for the plugin settings surface.
          Mounted once outside the Tabs so the contribution stays visible
          across all tabs and never visually attaches to a single one. */}
      <PluginExtensionSlot
        point="settings.plugins"
        className="border-t px-4 lg:px-6 py-3 empty:hidden"
      />
    </div>
  )
}

function PluginDeleteDialogHost() {
  const target = usePluginsStore((s) => s.deleteTarget)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  return (
    <PluginDeleteDialog
      open={target !== null}
      pluginName={target?.name ?? ""}
      onCancel={() => setDeleteTarget(null)}
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
        setDeleteTarget(null)
      }}
    />
  )
}
