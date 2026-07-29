"use client"

// The whole "marketplace sources" dialog as a pure function of its props.
//
// Split from the container on purpose: the states that matter most for this
// surface — a catalog mid-fetch, a repo that 404s, a source whose last sync
// failed — have no Dexie row that can express them, so a Storybook story or a
// test that seeds IndexedDB can only ever reach the boring half of the design.
// The container (`plugin-marketplace-sources-dialog.tsx`) owns the hook, the
// network call, and the toasts; everything below is render-only.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, GitBranchIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"

import { PluginSourcePreviewCard } from "./source-preview-card"
import { PluginMarketplaceSourceRow } from "./source-row"
import { PluginRecommendedSources } from "./recommended-sources"
import type {
  MarketplaceSourceItem,
  MarketplaceSourcePreview,
  RecommendedMarketplaceSource,
} from "./types"

export type SourcePreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; preview: MarketplaceSourcePreview }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void

  /** Raw text in the repository field. */
  input: string
  onInputChange: (value: string) => void
  /**
   * Canonical `owner/repo[@ref]` parsed from `input`, or null while the input
   * is empty / unparseable. Shown as a hint so the user sees what a pasted
   * `github.com/...` URL actually resolves to before spending a request.
   */
  resolvedRef: string | null
  previewState: SourcePreviewState
  onPreview: () => void
  onDismissPreview: () => void
  onConfirmAdd: () => void
  adding: boolean

  sources: MarketplaceSourceItem[]
  onRefreshAll: () => void
  refreshingAll: boolean
  onRefreshSource: (id: string) => void
  onRemoveSource: (id: string) => void
  onOpenRepo: (url: string) => void

  recommended: readonly RecommendedMarketplaceSource[]
  busyRecommendedRef: string | null
  onAddRecommended: (repoRef: string) => void
}

export function PluginMarketplaceSourcesDialogView({
  open,
  onOpenChange,
  input,
  onInputChange,
  resolvedRef,
  previewState,
  onPreview,
  onDismissPreview,
  onConfirmAdd,
  adding,
  sources,
  onRefreshAll,
  refreshingAll,
  onRefreshSource,
  onRemoveSource,
  onOpenRepo,
  recommended,
  busyRecommendedRef,
  onAddRecommended,
}: Props) {
  const t = useTranslations("plugins.marketplaceSources")
  const busy = previewState.kind === "loading" || adding
  const addedIds = new Set(sources.map((s) => s.id))
  const hasUnaddedRecommendations = recommended.some((s) => !addedIds.has(s.repoRef))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="marketplace-source-ref">{t("label")}</Label>
          <div className="flex gap-2">
            <Input
              id="marketplace-source-ref"
              placeholder={t("placeholder")}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) onPreview()
              }}
              disabled={busy}
            />
            <Button
              variant="outline"
              onClick={onPreview}
              disabled={busy}
              data-testid="marketplace-source-preview-submit"
            >
              {previewState.kind === "loading" ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                t("preview")
              )}
            </Button>
          </div>
          {resolvedRef && previewState.kind !== "ready" && (
            <p className="text-xs text-muted-foreground font-mono">
              {t("resolvedRef", { ref: resolvedRef })}
            </p>
          )}
          {previewState.kind === "error" && (
            <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertTriangleIcon className="size-3.5 mt-0.5 shrink-0" />
              {previewState.message}
            </p>
          )}
        </div>

        <ScrollArea className="flex-1 min-h-0 -mx-1 px-1">
          <div className="space-y-4">
            {previewState.kind === "loading" && (
              <Card
                className="p-3 gap-0 space-y-2"
                data-testid="marketplace-source-preview-skeleton"
              >
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
                <Separator className="my-1.5" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </Card>
            )}

            {previewState.kind === "ready" && (
              <PluginSourcePreviewCard
                preview={previewState.preview}
                adding={adding}
                onAdd={onConfirmAdd}
                onCancel={onDismissPreview}
                onOpenRepo={onOpenRepo}
              />
            )}

            <Separator />

            {sources.length === 0 ? (
              // Only shown when there is also nothing curated to offer — the
              // recommended block below is the better empty state when it has
              // anything in it.
              !hasUnaddedRecommendations && (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              )
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("savedTitle", { count: sources.length })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={onRefreshAll}
                    disabled={refreshingAll}
                    data-testid="marketplace-sources-refresh-all"
                  >
                    <RefreshCwIcon
                      className={`size-3.5 mr-1.5 ${refreshingAll ? "animate-spin" : ""}`}
                    />
                    {t("refreshAll")}
                  </Button>
                </div>
                {sources.map((source) => (
                  <PluginMarketplaceSourceRow
                    key={source.id}
                    source={source}
                    onRefresh={onRefreshSource}
                    onRemove={onRemoveSource}
                    onOpenRepo={onOpenRepo}
                  />
                ))}
              </div>
            )}

            {/* Kept below the saved list rather than swapped out with it: once
                the first curated source is added the block would otherwise
                vanish, and the second one would be reachable only by typing
                its reference by hand. */}
            {hasUnaddedRecommendations && (
              <PluginRecommendedSources
                sources={recommended}
                addedIds={addedIds}
                busyRepoRef={busyRecommendedRef}
                onAdd={onAddRecommended}
              />
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
