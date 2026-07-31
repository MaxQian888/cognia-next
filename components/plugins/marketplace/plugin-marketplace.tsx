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
import { useOpenVsxMarketplace } from "@/hooks/plugins/use-openvsx-marketplace"

type Section =
  "all" | "featured" | "popular" | "recent" | "builtin" | "workspace" | "shared" | "vscode"

const PAGE_SIZE = 12

export function PluginMarketplace() {
  const t = useTranslations("plugins.marketplace")
  const tv = useTranslations("plugins.openVsx")
  const market = usePluginMarketplace()
  const builtinEntries = useBuiltinPluginEntries()
  const [section, setSection] = useState<Section>("all")
  // Open VSX is a third-party registry: nothing is fetched until the user
  // actually opens the section. `enabled` is the whole gate.
  const openVsx = useOpenVsxMarketplace({ enabled: section === "vscode", pageSize: PAGE_SIZE })
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
    if (section !== "vscode" || vscodeClient) return
    void import("@/lib/plugin/vscode-shim/openvsx-install-flow").then((mod) =>
      setVscodeClient(mod.createOpenVsxInstallClient() as unknown as MarketplaceClient)
    )
  }, [section, vscodeClient])

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
      case "workspace":
        // Plugins from GitHub marketplace catalogs the user/org added.
        return sources.entries
      case "shared":
        // Plugins from the remote (shared) Cognia plugin registry.
        return allResults
      case "vscode":
        // VS Code extensions from Open VSX — a different registry entirely.
        // Deliberately not merged into "all": these aren't cognia plugins, and
        // the section is also the paging boundary (server-side, not client).
        return openVsx.entries
      default:
        // Merge GitHub marketplace-repo entries into the default browse view.
        return [...allResults, ...sources.entries]
    }
  })()

  const isVscodeSection = section === "vscode"
  // Open VSX pages on the server, so the grid renders everything fetched so far
  // and "Load more" asks for the next window. The other sections page on the
  // client over a fully-materialised list. One grid, two paging models.
  const visibleEntries = isVscodeSection ? sectionEntries : sectionEntries.slice(0, visibleCount)
  const canLoadMore = isVscodeSection ? openVsx.hasMore : visibleCount < sectionEntries.length

  /**
   * Which registry's loading / error state governs the content region.
   *
   * This used to be an early `return` above the toolbar, which had the effect
   * of replacing the entire page — including the section toggle — with the
   * cognia registry's error card. That made the VS Code section *unreachable*
   * whenever cognia's registry was unhappy, even though the section needs
   * nothing from it. Keeping the toolbar mounted and scoping the status to the
   * content region is what actually lets the user switch away from a failing
   * registry.
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
  const showDiscovery = section === "all" && market.query.trim() === ""

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip">
      <PluginMarketplaceModeBanner />
      {showDiscovery && <PluginDiscovery onInstall={(id, version) => onInstallById(id, version)} />}
      <div
        className="min-w-0 space-y-2 rounded-xl border bg-card/40 p-2.5 shadow-xs"
        data-testid="plugin-marketplace-toolbar"
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* Same Input, two data sources. The Open VSX hook debounces
              internally, so Enter is a redundant-but-harmless refresh there. */}
          <Input
            placeholder={isVscodeSection ? tv("searchPlaceholder") : t("searchPlaceholder")}
            aria-label={isVscodeSection ? tv("searchPlaceholder") : t("searchPlaceholder")}
            value={isVscodeSection ? openVsx.query : market.query}
            onChange={(e) =>
              isVscodeSection ? openVsx.setQuery(e.target.value) : market.setQuery(e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              if (isVscodeSection) openVsx.refresh()
              else void market.refresh()
            }}
            className="min-w-0 flex-1 bg-background/80 sm:max-w-lg"
          />
          <div className="flex shrink-0 items-center gap-1.5">
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
        <div className="flex min-w-0 items-center">
          <ScrollShadowRow
            className="min-w-0 flex-1"
            scrollerClassName="-mx-0.5 px-0.5 pb-0.5"
            testId="plugin-marketplace-sections"
          >
            <ToggleGroup
              type="single"
              value={section}
              onValueChange={(v) => v && setSection(v as Section)}
              variant="outline"
              size="sm"
              className="w-max"
            >
              <ToggleGroupItem value="all">{t("sections.all")}</ToggleGroupItem>
              <ToggleGroupItem value="featured">{t("sections.featured")}</ToggleGroupItem>
              <ToggleGroupItem value="popular">{t("sections.popular")}</ToggleGroupItem>
              <ToggleGroupItem value="recent">{t("sections.recent")}</ToggleGroupItem>
              <ToggleGroupItem value="builtin">{t("sections.builtin")}</ToggleGroupItem>
              <ToggleGroupItem value="workspace">{t("sections.workspace")}</ToggleGroupItem>
              <ToggleGroupItem value="shared">{t("sections.shared")}</ToggleGroupItem>
              <ToggleGroupItem value="vscode">{t("sections.vscode")}</ToggleGroupItem>
            </ToggleGroup>
          </ScrollShadowRow>
        </div>
      </div>

      {isVscodeSection && (
        <p className="text-xs text-muted-foreground">{tv("vscodeSectionHint")}</p>
      )}

      {status.kind === "loading" ? (
        <div className="space-y-3">
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
