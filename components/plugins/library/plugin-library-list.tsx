"use client"

// Library list body. Switches between the new compact list view and the
// pre-existing card grid (`PluginPanelGrid`) based on `listViewMode` from
// the plugins store. Handles three empty cases:
//
//   - loading                      → translated hint
//   - no plugins installed at all  → reuse Empty compound + Discover CTA
//   - filters yield nothing        → centered "no match" Card
//
// Selection / open-detail / configure / uninstall / review-permissions /
// rollback handlers are wired here so PluginLibraryRow stays presentation-
// only; this matches the wiring already done by `plugin-panel-grid.tsx`.

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { BoxesIcon, CompassIcon } from "lucide-react"
import { togglePluginEnabled } from "@/lib/plugin/core/toggle-plugin-enabled"
import type { PluginRow } from "@/lib/db/plugin-types"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { PluginPanelGrid } from "../plugin-panel-grid"
import { PluginLibraryRow } from "./plugin-library-row"
import { PluginLibraryListSkeleton, PluginLibraryGridSkeleton } from "./plugin-library-skeleton"

export function PluginLibraryList() {
  const t = useTranslations("plugins.grid")
  const tEmpty = useTranslations("plugins")
  const { filtered, totals, loading } = usePlugins()
  const viewMode = usePluginsStore((s) => s.listViewMode)
  const selection = usePluginsStore((s) => s.selection)
  const toggleSelection = usePluginsStore((s) => s.toggleSelection)
  const detailPluginId = usePluginsStore((s) => s.detailPluginId)
  const openDetail = usePluginsStore((s) => s.openDetail)
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const selectAll = usePluginsStore((s) => s.selectAll)
  const clearSelection = usePluginsStore((s) => s.clearSelection)

  // Stable handlers so the memoized rows only re-render when their own
  // plugin / selected / active props change (matters for 50+ plugin lists
  // where every keystroke used to re-render every row).
  const handleToggleEnabled = useCallback(
    (plugin: PluginRow) => void togglePluginEnabled(plugin.id, !plugin.enabled),
    []
  )
  const handleUninstall = useCallback(
    (plugin: PluginRow) => setDeleteTarget({ pluginId: plugin.id, name: plugin.name }),
    [setDeleteTarget]
  )

  if (loading) {
    return (
      <div className="p-4">
        {viewMode === "card" ? <PluginLibraryGridSkeleton /> : <PluginLibraryListSkeleton />}
      </div>
    )
  }

  if (totals.total === 0) {
    return (
      <div className="p-4">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>{t("emptyAll")}</EmptyTitle>
            <EmptyDescription>{tEmpty("description")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setActiveSection("discover")}>
              <CompassIcon className="mr-1.5 size-3.5" />
              {t("browseMarketplace")}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <Card className="m-4 p-6 text-center">
        <BoxesIcon className="mx-auto mb-2 size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("emptyFiltered")}</p>
      </Card>
    )
  }

  // Select-all over the *visible* (filtered) set — the batch-actions bar
  // appears as soon as anything is selected, so this is the entry point for
  // bulk enable/disable/uninstall without checking rows one by one.
  const allSelected = filtered.length > 0 && filtered.every((row) => selection.has(row.id))
  const someSelected = !allSelected && filtered.some((row) => selection.has(row.id))
  const selectAllBar = (
    <div className="flex items-center gap-2 border-b px-3 py-1.5">
      <Checkbox
        checked={allSelected ? true : someSelected ? "indeterminate" : false}
        onCheckedChange={() =>
          allSelected ? clearSelection() : selectAll(filtered.map((row) => row.id))
        }
        aria-label={t("selectAllAria")}
        data-testid="plugin-library-select-all"
      />
      <span className="text-xs text-muted-foreground">
        {t("selectAll", { count: filtered.length })}
      </span>
    </div>
  )

  if (viewMode === "card") {
    return (
      <>
        {selectAllBar}
        <div className="p-4">
          <PluginPanelGrid />
        </div>
      </>
    )
  }

  return (
    <>
      {selectAllBar}
      <div role="list" className="divide-y" data-testid="plugin-library-list">
        {filtered.map((row) => (
          <PluginLibraryRow
            key={row.id}
            plugin={row}
            selected={selection.has(row.id)}
            active={detailPluginId === row.id}
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
    </>
  )
}
