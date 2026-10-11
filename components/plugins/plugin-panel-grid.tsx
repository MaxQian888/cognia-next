"use client"

// Card grid that renders the filtered plugin list — the Library's "card"
// view mode. Its one caller, `PluginLibraryList`, owns the loading skeleton
// and both empty states (nothing installed / nothing matches) and only mounts
// the grid once there is at least one row to show. The grid used to carry its
// own copies of those three branches, which no render could reach; they were
// removed rather than left to drift from the list's real ones.

import { useCallback } from "react"
import { useLocale } from "next-intl"
import type { PluginRow } from "@/lib/db/plugin-types"
import { usePlugins } from "@/hooks/plugins"
import { usePluginEnableAction } from "@/hooks/plugins/use-plugin-enable-action"
import { localizePluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { usePluginsStore } from "@/stores/plugins"
import { PluginCard } from "./plugin-card"

export function PluginPanelGrid() {
  const locale = useLocale()
  const { filtered } = usePlugins()
  const selection = usePluginsStore((s) => s.selection)
  const toggleSelection = usePluginsStore((s) => s.toggleSelection)
  const openDetail = usePluginsStore((s) => s.openDetail)
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)

  // Stable handlers keep the memoized PluginCards from re-rendering when
  // unrelated store state (search query, selection elsewhere) changes.
  // Through the feedback hook, not straight to `setPluginEnabledForHost`: the
  // user is told whether the toggle applied, was queued for the desktop, or
  // failed (and why), instead of the result being dropped.
  const enablePlugin = usePluginEnableAction()
  const handleToggleEnabled = useCallback(
    (plugin: PluginRow) => void enablePlugin(plugin, !plugin.enabled),
    [enablePlugin]
  )
  const handleUninstall = useCallback(
    (plugin: PluginRow) =>
      setDeleteTarget({ pluginId: plugin.id, name: localizePluginText(plugin, locale).name }),
    [setDeleteTarget, locale]
  )

  // Column count tracks the grid's OWN width (`@container/plugin-grid`),
  // not the viewport. The grid renders inside the center pane (and is reused
  // in narrower embedded shells), so viewport breakpoints would pack 2–3
  // columns into a cramped pane and overlap the cards.
  return (
    <div className="@container/plugin-grid">
      <div className="grid gap-3 @lg/plugin-grid:grid-cols-2 @4xl/plugin-grid:grid-cols-3">
        {filtered.map((p) => (
          <PluginCard
            key={p.id}
            plugin={p}
            selected={selection.has(p.id)}
            onToggleSelect={toggleSelection}
            onOpen={openDetail}
            onConfigure={openConfigure}
            onToggleEnabled={handleToggleEnabled}
            onUninstall={handleUninstall}
            onReviewPermissions={openPermissionReview}
            onRollback={setRollbackTarget}
          />
        ))}
      </div>
    </div>
  )
}
