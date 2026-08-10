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
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

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
    <div className="flex flex-col gap-2" data-testid="marketplace-recommended-sources">
      <div className="text-xs font-medium text-muted-foreground">{t("recommendedTitle")}</div>
      <ItemGroup className="gap-2">
        {sources.map((source) => {
          const added = addedIds.has(source.repoRef)
          const busy = busyRepoRef === source.repoRef
          return (
            <Item
              key={source.repoRef}
              variant="outline"
              size="sm"
              data-testid={`marketplace-recommended-${source.repoRef}`}
            >
              <ItemContent className="min-w-0">
                <ItemTitle className="truncate">{source.name}</ItemTitle>
                <div className="text-xs text-muted-foreground font-mono truncate">
                  {source.repoRef}
                </div>
                <ItemDescription className="truncate text-xs">{source.description}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={added || busy}
                  onClick={() => onAdd(source.repoRef)}
                >
                  {busy ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
                  {added ? t("alreadyAdded") : t("add")}
                </Button>
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
      <p className="text-xs text-muted-foreground">{t("recommendedHint")}</p>
    </div>
  )
}
