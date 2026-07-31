"use client"

// The preview step of "add a marketplace source": what the catalog actually
// contains, rendered *before* the source is persisted.
//
// The data was already being fetched — `useGithubMarketplaceSources.add()`
// pulls the whole `marketplace.json` to validate the repo and then kept only
// its `name`. This card is what that discarded catalog looks like.
//
// Scope note: the plugin rows carry only what the catalog file declares
// (name / version / description). Resolving each plugin's manifest to roll up
// permissions would cost one GitHub API call per plugin against an
// unauthenticated 60/hour budget, so the honest thing here is the
// not-reviewed notice rather than a permission summary we can't afford.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PackageIcon,
  PlusIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"

import type { MarketplaceSourcePreview } from "./types"

/** Rows shown before the "…and N more" expander kicks in. */
const COLLAPSED_ROWS = 5

interface Props {
  preview: MarketplaceSourcePreview
  /** The add request is in flight. */
  adding: boolean
  onAdd: () => void
  /** Dismiss the preview and return to the bare input. */
  onCancel: () => void
  onOpenRepo: (url: string) => void
}

export function PluginSourcePreviewCard({ preview, adding, onAdd, onCancel, onOpenRepo }: Props) {
  const t = useTranslations("plugins.marketplaceSources")
  const [expanded, setExpanded] = useState(false)

  const { entries } = preview
  const hidden = Math.max(0, entries.length - COLLAPSED_ROWS)
  const visible = expanded ? entries : entries.slice(0, COLLAPSED_ROWS)

  return (
    <Card className="p-3 gap-0 space-y-3" data-testid="marketplace-source-preview">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{preview.name}</span>
            {preview.alreadyAdded && (
              <Badge variant="secondary" className="text-xs shrink-0">
                {t("alreadyAdded")}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {preview.owner && (
              <span className="truncate">{t("byOwner", { owner: preview.owner })}</span>
            )}
            {preview.owner && <span aria-hidden="true">·</span>}
            <span className="shrink-0">{t("pluginCount", { count: entries.length })}</span>
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate">{preview.id}</div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t("openOnGithub")}
          onClick={() => onOpenRepo(preview.repoUrl)}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>

      <Separator />

      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("emptyCatalog")}</p>
      ) : (
        <>
          <ScrollArea className={expanded ? "max-h-56 pr-2" : "pr-2"}>
            <ul className="space-y-1.5">
              {visible.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2">
                  <PackageIcon
                    className="size-3.5 mt-0.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm truncate">{entry.name}</span>
                      {entry.version && (
                        <span className="text-xs text-muted-foreground font-mono shrink-0">
                          v{entry.version}
                        </span>
                      )}
                    </div>
                    {entry.description && (
                      <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
          {hidden > 0 && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs self-start justify-start"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("showLess") : t("showMore", { count: hidden })}
            </Button>
          )}
        </>
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <AlertTriangleIcon className="size-3.5 mt-px shrink-0" aria-hidden="true" />
        {t("unreviewed")}
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={adding}>
          {t("cancel")}
        </Button>
        <Button
          size="sm"
          onClick={onAdd}
          disabled={adding || preview.alreadyAdded}
          data-testid="marketplace-source-preview-add"
        >
          {adding ? (
            <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5 mr-1.5" />
          )}
          {t("addThisSource")}
        </Button>
      </div>
    </Card>
  )
}
