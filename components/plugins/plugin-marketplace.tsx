"use client"

// Full marketplace surface — replaces the BrowseTab inline implementation.
// Three sections (featured / popular / recent) + a search box and a
// detail sheet driven by `selectedEntry` state. Install path goes through
// the unified hook so both the storefront card and detail CTA share state.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { AlertTriangleIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { listPlugins } from "@/lib/db/plugins"
import { usePluginMarketplace } from "@/hooks/plugins"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"
import { PluginMarketplaceCard } from "./plugin-marketplace-card"
import { PluginMarketplaceDetail } from "./plugin-marketplace-detail"
import { PluginDiscovery } from "./plugin-discovery"
import { ScrollShadowRow } from "./scroll-shadow-row"
import { PluginMarketplaceModeBanner } from "./plugin-marketplace-mode-banner"
import { PluginComparisonSheet, PluginComparisonTrigger } from "./plugin-comparison-sheet"

type Section = "all" | "featured" | "popular" | "recent"

export function PluginMarketplace() {
  const t = useTranslations("plugins.marketplace")
  const market = usePluginMarketplace()
  const [section, setSection] = useState<Section>("all")
  const [selectedEntry, setSelectedEntry] = useState<PluginMarketplaceEntry | null>(null)

  const installedRows = useLiveQuery(() => listPlugins(), [])
  const installedIds = useMemo(
    () => new Set((installedRows ?? []).map((r) => r.id)),
    [installedRows]
  )

  if (market.state.kind === "loading") {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }
  if (market.state.kind === "error") {
    return (
      <Card className="p-4 border-destructive">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangleIcon className="size-4" />
          <span className="text-sm">{t("error", { message: market.state.error })}</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => void market.refresh()}
          >
            {t("retry")}
          </Button>
        </div>
      </Card>
    )
  }

  const allResults = market.state.kind === "ready" ? market.state.results : []

  const sectionEntries = (() => {
    switch (section) {
      case "featured":
        return market.featured
      case "popular":
        return market.popular
      case "recent":
        return market.recent
      default:
        return allResults
    }
  })()

  // Discovery is shown as a hero strip whenever the user is in the default
  // "all" view with no active query — nudges first-time users toward
  // featured plugins without competing with their search results.
  const showDiscovery = section === "all" && market.query.trim() === ""

  return (
    <div className="space-y-4">
      <PluginMarketplaceModeBanner />
      {showDiscovery && <PluginDiscovery />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          placeholder={t("searchPlaceholder")}
          value={market.query}
          onChange={(e) => market.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void market.refresh()
          }}
          className="w-full sm:max-w-md"
        />
        <div className="flex items-center gap-2 min-w-0">
          <ScrollShadowRow
            className="flex-1 min-w-0"
            scrollerClassName="-mx-1 px-1 sm:overflow-visible sm:mx-0 sm:px-0"
            testId="plugin-marketplace-sections"
          >
            <ToggleGroup
              type="single"
              value={section}
              onValueChange={(v) => v && setSection(v as Section)}
              className="w-max"
            >
              <ToggleGroupItem value="all">{t("sections.all")}</ToggleGroupItem>
              <ToggleGroupItem value="featured">{t("sections.featured")}</ToggleGroupItem>
              <ToggleGroupItem value="popular">{t("sections.popular")}</ToggleGroupItem>
              <ToggleGroupItem value="recent">{t("sections.recent")}</ToggleGroupItem>
            </ToggleGroup>
          </ScrollShadowRow>
          <PluginComparisonTrigger />
        </div>
      </div>

      {sectionEntries.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{t("emptySection")}</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sectionEntries.map((entry) => (
            <PluginMarketplaceCard
              key={entry.id}
              entry={entry}
              installed={installedIds.has(entry.id)}
              installing={market.installingId === entry.id}
              onView={() => setSelectedEntry(entry)}
              onInstall={(id, version) => void market.install(id, version)}
              onUninstall={(id) => void market.uninstall(id)}
            />
          ))}
        </div>
      )}

      <PluginMarketplaceDetail
        open={selectedEntry !== null}
        entry={selectedEntry}
        installed={selectedEntry ? installedIds.has(selectedEntry.id) : false}
        installing={selectedEntry !== null && market.installingId === selectedEntry.id}
        onClose={() => setSelectedEntry(null)}
        onInstall={(id, version) => void market.install(id, version)}
        onUninstall={(id) => void market.uninstall(id)}
      />

      <PluginComparisonSheet
        entries={[...allResults, ...market.featured, ...market.popular, ...market.recent]}
        installedIds={installedIds}
        onInstall={(id, version) => void market.install(id, version)}
      />
    </div>
  )
}
