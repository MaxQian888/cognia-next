"use client"

// Full marketplace surface — replaces the BrowseTab inline implementation.
// Three sections (featured / popular / recent) + a search box and a
// detail sheet driven by `selectedEntry` state. Install path goes through
// the unified hook so both the storefront card and detail CTA share state.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { listPlugins } from "@/lib/db/plugins"
import { usePluginMarketplace, useBuiltinPluginEntries } from "@/hooks/plugins"
import type {
  MarketplaceClient,
  PluginMarketplaceEntry,
} from "@/hooks/plugins/use-plugin-marketplace"
import { loadPluginMarketplaceClient } from "@/hooks/plugins/use-plugin-marketplace"
import { usePluginPreInstall } from "@/hooks/plugins/use-plugin-pre-install"
import { GitBranchIcon } from "lucide-react"
import { useGithubMarketplaceSources } from "@/hooks/plugins/use-github-marketplace-sources"
import { PluginMarketplaceCard } from "./plugin-marketplace-card"
import { PluginMarketplaceDetail } from "./plugin-marketplace-detail"
import { PluginMarketplaceSourcesDialog } from "./plugin-marketplace-sources-dialog"
import { PluginInstallFromGithubDialog } from "../dialogs/plugin-install-from-github-dialog"
import { PluginDiscovery } from "../plugin-discovery"
import { PluginPreInstallDialog } from "../dialogs/plugin-pre-install-dialog"
import { ScrollShadowRow } from "../scroll-shadow-row"
import { PluginMarketplaceModeBanner } from "./plugin-marketplace-mode-banner"
import { PluginComparisonSheet, PluginComparisonTrigger } from "../dialogs/plugin-comparison-sheet"
import { PluginMarketplaceSkeleton } from "./plugin-marketplace-skeleton"
import { PluginEmptyState } from "../_shared/plugin-empty-state"
import { PluginErrorCard } from "../_shared/plugin-error-card"

type Section = "all" | "featured" | "popular" | "recent" | "builtin"

const PAGE_SIZE = 12

export function PluginMarketplace() {
  const t = useTranslations("plugins.marketplace")
  const market = usePluginMarketplace()
  const builtinEntries = useBuiltinPluginEntries()
  const [section, setSection] = useState<Section>("all")
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE)
  const [selectedEntry, setSelectedEntry] = useState<PluginMarketplaceEntry | null>(null)
  const sources = useGithubMarketplaceSources()
  const [sourcesDialogOpen, setSourcesDialogOpen] = useState(false)
  const [githubInstallRef, setGithubInstallRef] = useState<string | null>(null)

  // Reset the visible window whenever the section or query changes so we
  // don't stay zoomed into page 5 of "popular" after the user switches.
  // React 19: the documented prev-value compare pattern keeps the reset
  // out of `useEffect` (rule `react-hooks/set-state-in-effect`).
  const viewKey = `${section}|${market.query}`
  const [trackedView, setTrackedView] = useState(viewKey)
  if (trackedView !== viewKey) {
    setTrackedView(viewKey)
    setVisibleCount(PAGE_SIZE)
  }

  const installedRows = useLiveQuery(() => listPlugins(), [])
  const installedIds = useMemo(
    () => new Set((installedRows ?? []).map((r) => r.id)),
    [installedRows]
  )

  // Lazy-loaded client wraps the marketplace singleton; passed to the
  // pre-install hook so the orchestrator can pull manifests + call
  // installPlugin directly without going back through `market.install`
  // (which would skip the chain).
  const [client, setClient] = useState<MarketplaceClient | null>(null)
  useEffect(() => {
    void loadPluginMarketplaceClient().then(setClient)
  }, [])

  const preInstall = usePluginPreInstall(client)

  const runInstall = (entry: PluginMarketplaceEntry, version?: string) => {
    if (!client) return
    void preInstall.install(entry.id, version, entry.name).then((result) => {
      if (result.status === "installed") {
        toast.success(t("installSucceeded", { name: entry.name }))
        void market.refresh()
      } else if (result.status === "cancelled") {
        toast.message(t(`installCancelled.${result.stage}` as never))
      } else if (result.status === "failed") {
        toast.error(t("installFailed", { message: result.message }))
      }
    })
  }

  if (market.state.kind === "loading") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
        <PluginMarketplaceSkeleton />
      </div>
    )
  }
  if (market.state.kind === "error") {
    return (
      <PluginErrorCard
        message={t("error", { message: market.state.error })}
        onRetry={() => void market.refresh()}
      />
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
      case "builtin":
        return builtinEntries
      default:
        // Merge GitHub marketplace-repo entries into the default browse view.
        return [...allResults, ...sources.entries]
    }
  })()

  // Discovery is shown as a hero strip whenever the user is in the default
  // "all" view with no active query — nudges first-time users toward
  // featured plugins without competing with their search results.
  const showDiscovery = section === "all" && market.query.trim() === ""

  return (
    <div className="space-y-4">
      <PluginMarketplaceModeBanner />
      {showDiscovery && <PluginDiscovery onInstall={(id, version) => onInstallById(id, version)} />}
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
              <ToggleGroupItem value="builtin">{t("sections.builtin")}</ToggleGroupItem>
            </ToggleGroup>
          </ScrollShadowRow>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSourcesDialogOpen(true)}
            aria-label={t("manageSources")}
            data-testid="plugin-marketplace-manage-sources"
          >
            <GitBranchIcon className="size-3.5 lg:mr-1.5" />
            <span className="hidden lg:inline">{t("manageSources")}</span>
          </Button>
          <PluginComparisonTrigger />
        </div>
      </div>

      {sectionEntries.length === 0 ? (
        <PluginEmptyState hint={t("emptySection")} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sectionEntries.slice(0, visibleCount).map((entry) => (
              <PluginMarketplaceCard
                key={entry.id}
                entry={entry}
                installed={installedIds.has(entry.id)}
                installing={market.installingId === entry.id || preInstall.busy}
                onView={() => setSelectedEntry(entry)}
                onInstall={(id, version) => onInstallById(id, version)}
                onUninstall={(id) => void market.uninstall(id)}
              />
            ))}
          </div>
          {visibleCount < sectionEntries.length && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                data-testid="plugin-marketplace-load-more"
              >
                {t("loadMore", {
                  shown: Math.min(sectionEntries.length, visibleCount),
                  total: sectionEntries.length,
                })}
              </Button>
            </div>
          )}
        </>
      )}

      <PluginMarketplaceDetail
        open={selectedEntry !== null}
        entry={selectedEntry}
        installed={selectedEntry ? installedIds.has(selectedEntry.id) : false}
        installing={
          selectedEntry !== null && (market.installingId === selectedEntry.id || preInstall.busy)
        }
        onClose={() => setSelectedEntry(null)}
        onInstall={(id, version) => onInstallById(id, version)}
        onUninstall={(id) => void market.uninstall(id)}
      />

      <PluginComparisonSheet
        entries={[...allResults, ...market.featured, ...market.popular, ...market.recent]}
        installedIds={installedIds}
        onInstall={(id, version) => onInstallById(id, version)}
      />

      <PluginPreInstallDialog
        target={preInstall.target}
        onContinue={preInstall.resolveContinue}
        onCancel={preInstall.resolveCancel}
      />

      <PluginMarketplaceSourcesDialog
        open={sourcesDialogOpen}
        onOpenChange={setSourcesDialogOpen}
      />

      {/* Installing a marketplace-repo (git) entry reuses the single-plugin
          GitHub install dialog — same preview + pre-install chain. */}
      <PluginInstallFromGithubDialog
        open={githubInstallRef !== null}
        initialRef={githubInstallRef ?? undefined}
        onOpenChange={(open) => {
          if (!open) setGithubInstallRef(null)
        }}
      />
    </div>
  )

  function onInstallById(id: string, version?: string) {
    // GitHub marketplace-repo entries route through the GitHub install dialog
    // (pre-filled) rather than the registry pre-install chain.
    const gitEntry = sources.entries.find((e) => e.id === id)
    if (gitEntry) {
      const g = gitEntry.github
      setGithubInstallRef(
        `${g.owner}/${g.repo}${g.ref ? `@${g.ref}` : ""}${g.subdir ? `/${g.subdir}` : ""}`
      )
      return
    }
    const entry = [...allResults, ...market.featured, ...market.popular, ...market.recent].find(
      (e) => e.id === id
    )
    if (entry) runInstall(entry, version)
  }
}
