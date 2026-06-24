"use client"

// Card grid that renders the filtered plugin list. Decomposed out of
// `plugin-panel.tsx` so other surfaces (Settings overlay / embedded
// shells) can reuse the grid without bringing in the full panel header
// and tabs.

import { useTranslations } from "next-intl"
import { BoxesIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { setPluginEnabled } from "@/lib/db/plugins"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { PluginCard } from "./plugin-card"
import { PluginLibraryGridSkeleton } from "./library/plugin-library-skeleton"

export function PluginPanelGrid() {
  const t = useTranslations("plugins.grid")
  const { filtered, totals, loading } = usePlugins()
  const selection = usePluginsStore((s) => s.selection)
  const toggleSelection = usePluginsStore((s) => s.toggleSelection)
  const openDetail = usePluginsStore((s) => s.openDetail)
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)

  if (loading) {
    return <PluginLibraryGridSkeleton />
  }

  if (totals.total === 0) {
    return (
      <Card className="p-6 md:p-8 text-center space-y-3">
        <BoxesIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("emptyAll")}</p>
        <Button size="sm" onClick={() => setActiveSection("discover")}>
          {t("browseMarketplace")}
        </Button>
      </Card>
    )
  }

  if (filtered.length === 0) {
    return (
      <Card className="p-6 md:p-8 text-center space-y-2">
        <BoxesIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("emptyFiltered")}</p>
      </Card>
    )
  }

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
            onToggleEnabled={(plugin) => void setPluginEnabled(plugin.id, !plugin.enabled)}
            onUninstall={(plugin) => setDeleteTarget({ pluginId: plugin.id, name: plugin.name })}
            onReviewPermissions={openPermissionReview}
            onRollback={setRollbackTarget}
          />
        ))}
      </div>
    </div>
  )
}
