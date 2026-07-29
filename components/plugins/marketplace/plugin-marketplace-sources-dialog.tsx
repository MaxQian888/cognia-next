"use client"

// Manage GitHub "marketplace repo" sources (Claude-Code-style plugin
// dispatch). Add a repo that ships a marketplace.json catalog; its plugins
// then appear in the browse grid.
//
// Container only: it owns the input/preview state machine, the hook, the
// GitHub calls and the toasts. Everything visual lives in
// `sources/sources-dialog-view.tsx` — see the comment there for why the split
// is load-bearing rather than decorative.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { openUrl } from "@/lib/native/opener"
import { useGithubMarketplaceSources } from "@/hooks/plugins/use-github-marketplace-sources"
import { githubRepoUrl, parseGithubPluginRef } from "@/lib/plugin/package/github-source"
import type { MarketplaceCatalog } from "@/lib/plugin/package/github-marketplace"
import { RECOMMENDED_MARKETPLACE_SOURCES } from "@/lib/plugin/package/recommended-marketplace-sources"
import type { PluginMarketplaceSourceRow } from "@/lib/db/plugin-types"

import { PluginMarketplaceSourcesDialogView } from "./sources/sources-dialog-view"
import type { SourcePreviewState } from "./sources/sources-dialog-view"
import type { MarketplaceSourceItem, SourceSyncState } from "./sources/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** `owner/repo[@ref]` for display, or null when the input can't be parsed yet. */
function resolveRef(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const ref = parseGithubPluginRef(trimmed)
    return `${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ""}`
  } catch {
    return null
  }
}

/** Best-effort repo URL; falls back to a search-free github.com root. */
function rowRepoUrl(row: PluginMarketplaceSourceRow): string {
  try {
    return githubRepoUrl(parseGithubPluginRef(row.repoRef))
  } catch {
    return "https://github.com"
  }
}

/**
 * Row + in-flight state → the row's sync status.
 *
 * `lastError` outranks `lastSyncedAt`: a source that synced yesterday and
 * failed this morning is failing, and showing yesterday's healthy count as the
 * headline would bury the thing the user needs to act on.
 */
function toSyncState(row: PluginMarketplaceSourceRow, syncing: boolean): SourceSyncState {
  if (syncing) return { kind: "syncing" }
  if (row.lastError)
    return { kind: "error", message: row.lastError, lastSyncedAt: row.lastSyncedAt }
  if (row.lastSyncedAt !== undefined && row.pluginCount !== undefined) {
    return { kind: "ok", pluginCount: row.pluginCount, lastSyncedAt: row.lastSyncedAt }
  }
  return { kind: "never" }
}

export function PluginMarketplaceSourcesDialog({ open, onOpenChange }: Props) {
  const t = useTranslations("plugins.marketplaceSources")
  const { sources, syncingIds, preview, commitPreview, add, remove, refresh, refreshSource } =
    useGithubMarketplaceSources()

  const [input, setInput] = useState("")
  const [previewState, setPreviewState] = useState<SourcePreviewState>({ kind: "idle" })
  const [adding, setAdding] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [busyRecommendedRef, setBusyRecommendedRef] = useState<string | null>(null)
  // The catalog behind the current preview, kept so confirming costs no second
  // fetch — the whole point of previewing is that we already paid for it.
  const [previewCatalog, setPreviewCatalog] = useState<MarketplaceCatalog | null>(null)

  const items: MarketplaceSourceItem[] = sources.map((row) => ({
    id: row.id,
    name: row.name,
    repoRef: row.repoRef,
    repoUrl: rowRepoUrl(row),
    sync: toSyncState(row, syncingIds.has(row.id)),
  }))
  const addedIds = new Set(sources.map((s) => s.id))

  const dismissPreview = () => {
    setPreviewState({ kind: "idle" })
    setPreviewCatalog(null)
  }

  const handleInputChange = (value: string) => {
    setInput(value)
    // Any preview on screen described the previous text; keeping it while the
    // user edits would let them confirm a source they are no longer looking at.
    if (previewState.kind !== "idle") dismissPreview()
  }

  const runPreview = async () => {
    const trimmed = input.trim()
    if (!trimmed) {
      setPreviewState({ kind: "error", message: t("emptyError") })
      return
    }
    setPreviewState({ kind: "loading" })
    setPreviewCatalog(null)
    try {
      const catalog = await preview(trimmed)
      setPreviewCatalog(catalog)
      setPreviewState({
        kind: "ready",
        preview: {
          id: catalog.id,
          name: catalog.name,
          owner: catalog.owner,
          catalogPath: catalog.catalogPath,
          repoUrl: catalog.repoUrl,
          alreadyAdded: addedIds.has(catalog.id),
          entries: catalog.entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            version: entry.version,
            description: entry.description,
          })),
        },
      })
    } catch (err) {
      setPreviewState({
        kind: "error",
        message: t("fetchError", { message: err instanceof Error ? err.message : String(err) }),
      })
    }
  }

  const confirmAdd = async () => {
    if (!previewCatalog) return
    setAdding(true)
    try {
      await commitPreview(input.trim(), previewCatalog)
      setInput("")
      dismissPreview()
    } catch (err) {
      setPreviewState({
        kind: "error",
        message: t("addError", { message: err instanceof Error ? err.message : String(err) }),
      })
    } finally {
      setAdding(false)
    }
  }

  const addRecommended = async (repoRef: string) => {
    setBusyRecommendedRef(repoRef)
    try {
      await add(repoRef)
    } catch (err) {
      // No preview card is on screen for this path, so the error has nowhere
      // inline to live.
      toast.error(t("addError", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusyRecommendedRef(null)
    }
  }

  const refreshAll = async () => {
    setRefreshingAll(true)
    try {
      await refresh()
    } finally {
      setRefreshingAll(false)
    }
  }

  return (
    <PluginMarketplaceSourcesDialogView
      open={open}
      onOpenChange={onOpenChange}
      input={input}
      onInputChange={handleInputChange}
      resolvedRef={resolveRef(input)}
      previewState={previewState}
      onPreview={() => void runPreview()}
      onDismissPreview={dismissPreview}
      onConfirmAdd={() => void confirmAdd()}
      adding={adding}
      sources={items}
      onRefreshAll={() => void refreshAll()}
      refreshingAll={refreshingAll}
      onRefreshSource={(id) => void refreshSource(id)}
      onRemoveSource={(id) => void remove(id)}
      onOpenRepo={(url) => void openUrl(url)}
      recommended={RECOMMENDED_MARKETPLACE_SOURCES}
      busyRecommendedRef={busyRecommendedRef}
      onAddRecommended={(repoRef) => void addRecommended(repoRef)}
    />
  )
}
