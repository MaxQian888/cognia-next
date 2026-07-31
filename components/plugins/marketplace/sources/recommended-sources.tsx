"use client"

// Curated marketplaces offered when the user has no sources yet.
//
// The old empty state was a dead end ("No sources added yet.") — it named the
// thing that was missing without saying where to get one. This is the Scoop
// `known buckets` / HACS default-repositories move: one click to a working
// first source, with the free-form input still there for anything else.
//
// Renders nothing when the curated list is empty, so the caller can fall back
// to its plain empty state rather than showing an empty heading.

import { useTranslations } from "next-intl"
import { Loader2Icon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

import type { RecommendedMarketplaceSource } from "./types"

interface Props {
  sources: readonly RecommendedMarketplaceSource[]
  /** Canonical ids already saved — those entries render as added, not addable. */
  addedIds: ReadonlySet<string>
  /** The repoRef currently being added, if any. */
  busyRepoRef: string | null
  onAdd: (repoRef: string) => void
}

export function PluginRecommendedSources({ sources, addedIds, busyRepoRef, onAdd }: Props) {
  const t = useTranslations("plugins.marketplaceSources")
  if (sources.length === 0) return null

  return (
    <div className="space-y-2" data-testid="marketplace-recommended-sources">
      <div className="text-xs font-medium text-muted-foreground">{t("recommendedTitle")}</div>
      <div className="space-y-2">
        {sources.map((source) => {
          const added = addedIds.has(source.repoRef)
          const busy = busyRepoRef === source.repoRef
          return (
            <Card
              key={source.repoRef}
              className="flex flex-row items-center justify-between gap-2 p-2.5"
              data-testid={`marketplace-recommended-${source.repoRef}`}
            >
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium truncate">{source.name}</div>
                <div className="text-xs text-muted-foreground font-mono truncate">
                  {source.repoRef}
                </div>
                <p className="text-xs text-muted-foreground truncate">{source.description}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={added || busy}
                onClick={() => onAdd(source.repoRef)}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <PlusIcon className="size-3.5 mr-1.5" />
                )}
                {added ? t("alreadyAdded") : t("add")}
              </Button>
            </Card>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t("recommendedHint")}</p>
    </div>
  )
}
