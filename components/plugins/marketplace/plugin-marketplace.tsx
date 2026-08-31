"use client"

// Full marketplace surface.
//
// Browsing is two axes, not one. `discoverOrigin` picks which registry or
// catalog answers, `discoverCuration` filters that answer by a ranking the
// cognia registry publishes, and the two compose as AND. Both live in the
// plugins store because the controls that drive them render in the page
// header (`PluginDiscoverHeader`), not in this pane. This file used to draw
// its own Card toolbar here with a single eight-item switch that mixed the two
// questions, which is why "featured extensions on Open VSX" could not be asked
// and why picking a registry silently threw away the chosen ranking.
//
// Install path goes through the unified hook so both the storefront card and
// the detail CTA share state.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
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
import { PluginMarketplaceModeBanner } from "./plugin-marketplace-mode-banner"
import { PluginComparisonSheet, PluginComparisonTrigger } from "../dialogs/plugin-comparison-sheet"
import { PluginMarketplaceSkeleton } from "./plugin-marketplace-skeleton"
import { PluginEmptyState } from "../_shared/plugin-empty-state"
import { PluginErrorCard } from "../_shared/plugin-error-card"
import { useOpenVsxMarketplace } from "@/hooks/plugins/use-openvsx-marketplace"
import { usePluginsStore } from "@/stores/plugins"

const PAGE_SIZE = 12

export function PluginMarketplace() {
  const t = useTranslations("plugins.marketplace")
  const tv = useTranslations("plugins.openVsx")
  const market = usePluginMarketplace()
  const builtinEntries = useBuiltinPluginEntries()
  const curation = usePluginsStore((s) => s.discoverCuration)
  const origin = usePluginsStore((s) => s.discoverOrigin)
  // Open VSX is a third-party registry: nothing is fetched until the user
  // actually selects it as the origin. `enabled` is the whole gate.
  const openVsx = useOpenVsxMarketplace({ enabled: origin === "vscode", pageSize: PAGE_SIZE })
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE)
  const [selectedEntry, setSelectedEntry] = useState<PluginMarketplaceEntry | null>(null)
  const sources = useGithubMarketplaceSources()
  const [sourcesDialogOpen, setSourcesDialogOpen] = useState(false)
  const [githubInstallRef, setGithubInstallRef] = useState<string | null>(null)

  /**
   * The search box moved to the page header, so `filters.query` in the plugins
   * store is now the single source and this pane pushes it down to whichever
   * registry hook is answering. Both hooks are updated, not just the active
   * one, so switching origin keeps the term the user typed. Written with the
   * documented prev-value compare rather than an effect, same as the paging
   * reset above.
   */
  const storeQuery = usePluginsStore((s) => s.filters.query)
  const [seenQuery, setSeenQuery] = useState(storeQuery)
  if (storeQuery !== seenQuery) {
    setSeenQuery(storeQuery)
    market.setQuery(storeQuery)
    openVsx.setQuery(storeQuery)
  }

  // Reset the visible window whenever either axis or the query changes so we
  // don't stay zoomed into page 5 of "popular" after the user switches.
  // React 19: the documented prev-value compare pattern keeps the reset
  // out of `useEffect` (rule `react-hooks/set-state-in-effect`).
  const viewKey = `${origin}|${curation}|${storeQuery}`
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

  /**
   * Unsupported-API warnings for already-installed VS Code extensions, read
   * back from the manifest the adapter persisted. This is what keeps the
   * "uses APIs cognia doesn't implement" warning on the card after install —
   * a warning that only existed in the install dialog would vanish exactly
   * when the extension starts misbehaving.
   */
  const unsupportedApisById = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const row of installedRows ?? []) {
      const block = (
        row.manifest as { vscodeExtension?: { unsupportedApis?: unknown } } | undefined
      )?.vscodeExtension
      const apis = block?.unsupportedApis
      if (Array.isArray(apis) && apis.length > 0) {
        map.set(
          row.id,
          apis.filter((a): a is string => typeof a === "string")
        )
      }
    }
    return map
  }, [installedRows])

  // Lazy-loaded client wraps the marketplace singleton; passed to the
  // pre-install hook so the orchestrator can pull manifests + call
  // installPlugin directly without going back through `market.install`
  // (which would skip the chain).
  const [client, setClient] = useState<MarketplaceClient | null>(null)
  useEffect(() => {
    void loadPluginMarketplaceClient().then(setClient)
  }, [])

  /**
   * The Open VSX install client, loaded only once the section is opened — it
   * drags in JSZip and `@babel/parser` (the `.vsix` parser and the permission
   * inference walk), which has no business loading for a user who never browses
   * VS Code extensions.
   */
  const [vscodeClient, setVscodeClient] = useState<MarketplaceClient | null>(null)
  useEffect(() => {
    if (origin !== "vscode" || vscodeClient) return
    void import("@/lib/plugin/vscode-shim/openvsx-install-flow").then((mod) =>
      setVscodeClient(mod.createOpenVsxInstallClient() as unknown as MarketplaceClient)
    )
  }, [origin, vscodeClient])

  const preInstall = usePluginPreInstall(client)
  // A second instance rather than a shared one: the two consent chains are
  // driven by different clients, and only one can have a live target at a time
  // (a dialog is modal), so the dialogs below never both open.
  const vscodePreInstall = usePluginPreInstall(vscodeClient)

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

  const allResults =
    market.state.kind === "ready" && Array.isArray(market.state.results) ? market.state.results : []

  /**
   * The curation axis: which of the cognia registry's lists to read.
   *
   * `curationAnswerableBy` keeps the control from offering a ranking a
   * non-registry origin cannot answer, so this only ever chooses among lists
   * the registry itself publishes.
   */
  const registryEntries =
    curation === "featured"
      ? market.featured
      : curation === "popular"
        ? market.popular
        : curation === "recent"
          ? market.recent
          : allResults

  /** The origin axis: which registry or catalog answers at all. */
  const sectionEntries = (() => {
    switch (origin) {
      case "builtin":
        return builtinEntries
      case "workspace":
        // Plugins from GitHub marketplace catalogs the user/org added.
        return sources.entries
      case "registry":
        // The remote (shared) Cognia plugin registry on its own.
        return registryEntries
      case "vscode":
        // VS Code extensions from Open VSX, a different registry entirely.
        // Deliberately not merged into "all": these aren't cognia plugins, and
        // the origin is also the paging boundary (server-side, not client).
        return openVsx.entries
      default:
        // "All sources" merges the GitHub marketplace-repo entries in, but
        // only while no ranking is chosen. A git catalog publishes no
        // featured / popular / recent list, so including its entries under a
        // ranking would claim a standing they were never given.
        return curation === "all" ? [...allResults, ...sources.entries] : registryEntries
    }
  })()

  const isVscodeSection = origin === "vscode"
  // Open VSX pages on the server, so the grid renders everything fetched so far
  // and "Load more" asks for the next window. The other sections page on the
  // client over a fully-materialised list. One grid, two paging models.
  const visibleEntries = isVscodeSection ? sectionEntries : sectionEntries.slice(0, visibleCount)
  const canLoadMore = isVscodeSection ? openVsx.hasMore : visibleCount < sectionEntries.length

  /**
   * Which registry's loading / error state governs the content region.
   *
   * This used to be an early `return` above the toolbar, which had the effect
   * of replacing the entire page — including the origin picker — with the
   * cognia registry's error card. That made Open VSX *unreachable* whenever
   * cognia's registry was unhappy, even though it needs nothing from it. The
   * picker now lives in the page header, and scoping the status to the content
   * region is what lets the user switch away from a failing registry.
   */
  const status:
    | { kind: "loading" }
    | { kind: "error"; message: string; retry: () => void }
    | { kind: "ready" } = isVscodeSection
    ? openVsx.state.kind === "error"
      ? {
          kind: "error",
          message: tv("vscodeError", { message: openVsx.state.error }),
          retry: () => openVsx.refresh(),
        }
      : openVsx.state.kind === "loading" && sectionEntries.length === 0
        ? { kind: "loading" }
        : { kind: "ready" }
    : market.state.kind === "loading"
      ? { kind: "loading" }
      : market.state.kind === "error"
        ? {
            kind: "error",
            message: t("error", { message: market.state.error }),
            retry: () => void market.refresh(),
          }
        : { kind: "ready" }

  // Discovery is shown as a hero strip whenever the user is in the default
  // "all" view with no active query — nudges first-time users toward
  // featured plugins without competing with their search results.
  const showDiscovery = origin === "all" && curation === "all" && storeQuery.trim() === ""

  return (
    <div className="@container/plugin-discover flex w-full min-w-0 max-w-full flex-col gap-4 overflow-x-clip">
      <PluginMarketplaceModeBanner />
      {showDiscovery && <PluginDiscovery onInstall={(id, version) => onInstallById(id, version)} />}
      {/* Search, ranking and source now live in the page header's controls
          tier (`PluginDiscoverHeader`), the same tier every other section
          uses. What is left here are the two actions that open something. */}
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSourcesDialogOpen(true)}
          aria-label={t("manageSources")}
          data-testid="plugin-marketplace-manage-sources"
        >
          <GitBranchIcon className="size-3.5" />
          <span className="hidden @lg/plugin-discover:inline">{t("manageSources")}</span>
        </Button>
        <PluginComparisonTrigger />
      </div>

      {isVscodeSection && (
        <p className="text-xs text-muted-foreground">{tv("vscodeSectionHint")}</p>
      )}

      {status.kind === "loading" ? (
        <div className="flex flex-col gap-3">
          {!isVscodeSection && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
          <PluginMarketplaceSkeleton />
        </div>
      ) : status.kind === "error" ? (
        <PluginErrorCard message={status.message} onRetry={status.retry} />
      ) : sectionEntries.length === 0 ? (
        <PluginEmptyState hint={isVscodeSection ? tv("vscodeEmpty") : t("emptySection")} />
      ) : (
        <>
          {/* Container-query columns (not viewport): the marketplace renders
              inside the center pane, so viewport breakpoints would overlap the
              cards when the window is wide but the pane is narrow. */}
          <div className="@container/plugin-grid">
            <div className="grid gap-3 @lg/plugin-grid:grid-cols-2 @4xl/plugin-grid:grid-cols-3">
              {visibleEntries.map((entry) => (
                <PluginMarketplaceCard
                  key={entry.id}
                  entry={entry}
                  installed={installedIds.has(entry.id)}
                  installing={
                    market.installingId === entry.id ||
                    (isVscodeSection ? vscodePreInstall.busy : preInstall.busy)
                  }
                  // Absent for every non-Open-VSX entry, which keeps the
                  // existing sections' render byte-identical.
                  verifiedPublisher={(entry as { verifiedPublisher?: boolean }).verifiedPublisher}
                  // Only ever true once installed: before that, nothing has
                  // been checked, and the badge would be claiming work we
                  // haven't done.
                  integrityChecked={isVscodeSection && installedIds.has(entry.id)}
                  unsupportedApis={unsupportedApisById.get(entry.id)}
                  onView={() => setSelectedEntry(entry)}
                  onInstall={(id, version) => onInstallById(id, version)}
                  onUninstall={(id) => void market.uninstall(id)}
                />
              ))}
            </div>
          </div>
          {canLoadMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  isVscodeSection ? openVsx.loadMore() : setVisibleCount((c) => c + PAGE_SIZE)
                }
                disabled={isVscodeSection && openVsx.state.kind === "loading"}
                data-testid="plugin-marketplace-load-more"
              >
                {isVscodeSection
                  ? tv("vscodeLoadMore", {
                      shown: openVsx.entries.length,
                      total: openVsx.total,
                    })
                  : t("loadMore", {
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

      {/* The Open VSX consent chain. Same dialog, same steps — the permissions
          it shows are the ones inferred from the downloaded bundle, unioned
          across the whole dependency graph. */}
      <PluginPreInstallDialog
        target={vscodePreInstall.target}
        notice={tv("installNotice")}
        onContinue={vscodePreInstall.resolveContinue}
        onCancel={vscodePreInstall.resolveCancel}
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

    // Open VSX entries route to their own client — same shape of early return
    // as the GitHub branch above. The consent chain is identical; only the
    // `{getPlugin, installPlugin}` implementation behind it differs (it
    // resolves the dependency graph, downloads, verifies, and infers
    // permissions from the real bundle).
    const vscodeEntry = openVsx.entries.find((e) => e.id === id)
    if (vscodeEntry) {
      if (!vscodeClient) return
      void vscodePreInstall.install(id, version, vscodeEntry.name).then((result) => {
        if (result.status === "installed") {
          toast.success(t("installSucceeded", { name: vscodeEntry.name }))
        } else if (result.status === "cancelled") {
          toast.message(t(`installCancelled.${result.stage}` as never))
        } else if (result.status === "failed") {
          toast.error(t("installFailed", { message: result.message }))
        }
      })
      return
    }

    const entry = [...allResults, ...market.featured, ...market.popular, ...market.recent].find(
      (e) => e.id === id
    )
    if (entry) runInstall(entry, version)
  }
}
