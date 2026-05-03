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
  const setActiveTab = usePluginsStore((s) => s.setActiveTab)

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  if (totals.total === 0) {
    return (
      <Card className="p-8 text-center space-y-3">
        <BoxesIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("emptyAll")}</p>
        <Button size="sm" onClick={() => setActiveTab("browse")}>
          {t("browseMarketplace")}
        </Button>
      </Card>
    )
  }

  if (filtered.length === 0) {
    return (
      <Card className="p-8 text-center space-y-2">
        <BoxesIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("emptyFiltered")}</p>
      </Card>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
  )
}
